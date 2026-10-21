//! Video frames drawn straight from YUV planes on the GPU (an egui_glow paint
//! callback): the stream helper skips its RGBA conversion and the GPU scales.
//! The only unsafe code in Harbor: raw GL calls, all in this file.
#![allow(unsafe_code)]

use eframe::egui::{self, Rect};
use eframe::egui_glow;
use eframe::glow::{self, HasContext};
use std::sync::{Arc, Mutex};

/// A frame as the helper wrote it.
pub struct Planes {
    pub nv12: bool,
    pub w: u32,
    pub h: u32,
    pub bt709: bool,
    pub full_range: bool,
    pub bytes: Vec<u8>,
}

#[derive(Default)]
struct Gl {
    program: Option<glow::Program>,
    vao: Option<glow::VertexArray>,
    tex: Vec<glow::Texture>,
    /// set once, when the shader can't be built here
    failed: bool,
    pending: Option<Planes>,
    /// what's in the textures: nv12, bt709, full range
    shown: Option<(bool, bool, bool)>,
}

/// One video's GPU state. Cheap to clone (shared with the paint callback).
#[derive(Clone, Default)]
pub struct Video(Arc<Mutex<Gl>>);

/// GL objects of dropped videos, deleted at the next paint (only there is a context).
static GRAVE: Mutex<Vec<(Option<glow::Program>, Option<glow::VertexArray>, Vec<glow::Texture>)>> = Mutex::new(Vec::new());

impl Drop for Gl {
    fn drop(&mut self) {
        if let Ok(mut g) = GRAVE.lock() {
            g.push((self.program.take(), self.vao.take(), std::mem::take(&mut self.tex)));
        }
    }
}

impl Video {
    /// Upload this frame at the next paint.
    pub fn set(&self, p: Planes) {
        if let Ok(mut g) = self.0.lock() {
            g.pending = Some(p);
        }
    }

    /// The shader couldn't be built (old GL): use RGBA frames instead.
    pub fn failed(&self) -> bool {
        self.0.lock().map(|g| g.failed).unwrap_or(true)
    }

    /// Something to draw yet?
    pub fn has_frame(&self) -> bool {
        self.0.lock().map(|g| g.shown.is_some() || g.pending.is_some()).unwrap_or(false)
    }

    pub fn paint(&self, painter: &egui::Painter, rect: Rect) {
        let video = self.clone();
        let cb = egui_glow::CallbackFn::new(move |_info, p| {
            let gl = p.gl();
            bury(gl);
            if let Ok(mut g) = video.0.lock() {
                g.draw(gl);
            }
        });
        painter.add(egui::PaintCallback { rect, callback: Arc::new(cb) });
    }
}

// Every unsafe block below is a raw GL call. Shared conditions (the SAFETY notes
// refer to them): it runs inside an egui_glow paint callback, on the thread whose
// GL context is current, which is the context `gl` belongs to; the objects used were
// created by that same context (Harbor has a single one) and are deleted only here.

fn bury(gl: &glow::Context) {
    let dead = GRAVE.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default();
    for (prog, vao, tex) in dead {
        // SAFETY: see above; each object is deleted once (it left its owner on drop).
        unsafe {
            if let Some(p) = prog {
                gl.delete_program(p);
            }
            if let Some(v) = vao {
                gl.delete_vertex_array(v);
            }
            for t in tex {
                gl.delete_texture(t);
            }
        }
    }
}

const VS: &str = r#"
out vec2 v_uv;
void main() {
    vec2 p = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
    v_uv = vec2(p.x, 1.0 - p.y);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
"#;

const FS: &str = r#"
in vec2 v_uv;
out vec4 color;
uniform sampler2D t_y;
uniform sampler2D t_u;
uniform sampler2D t_v;
uniform int nv12;
uniform int bt709;
uniform int full_range;
void main() {
    float y = texture(t_y, v_uv).r;
    vec2 c = nv12 == 1 ? texture(t_u, v_uv).rg : vec2(texture(t_u, v_uv).r, texture(t_v, v_uv).r);
    if (full_range == 1) {
        c -= 0.5;
    } else {
        y = (y - 16.0 / 255.0) * (255.0 / 219.0);
        c = (c - 128.0 / 255.0) * (255.0 / 224.0);
    }
    vec3 rgb = bt709 == 1
        ? vec3(y + 1.5748 * c.y, y - 0.1873 * c.x - 0.4681 * c.y, y + 1.8556 * c.x)
        : vec3(y + 1.402 * c.y, y - 0.344136 * c.x - 0.714136 * c.y, y + 1.772 * c.x);
    color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
"#;

impl Gl {
    /// Compile the shader and make the textures. False when this GL can't (the
    /// caller falls back to RGBA); whatever was made is still freed on drop.
    fn build(&mut self, gl: &glow::Context) -> bool {
        let version = egui_glow::ShaderVersion::get(gl);
        if !version.is_new_shader_interface() {
            return false;
        }
        let decl = version.version_declaration();
        let head = if decl.contains(" es") { format!("{decl}precision mediump float;\n") } else { decl.to_string() };
        // SAFETY: see above (program/shader objects, compile and link; no pointers).
        let linked = unsafe {
            let Ok(prog) = gl.create_program() else { return false };
            self.program = Some(prog); // freed on drop even if this fails
            let mut shaders = Vec::new();
            let mut compiled = true;
            for (kind, src) in [(glow::VERTEX_SHADER, VS), (glow::FRAGMENT_SHADER, FS)] {
                let Ok(s) = gl.create_shader(kind) else { break };
                gl.shader_source(s, &format!("{head}{src}"));
                gl.compile_shader(s);
                if !gl.get_shader_compile_status(s) {
                    eprintln!("yuv shader: {}", gl.get_shader_info_log(s));
                    compiled = false;
                }
                gl.attach_shader(prog, s);
                shaders.push(s);
            }
            let linked = compiled && shaders.len() == 2 && {
                gl.link_program(prog);
                gl.get_program_link_status(prog)
            };
            if compiled && !linked {
                eprintln!("yuv shader: {}", gl.get_program_info_log(prog));
            }
            for s in shaders {
                gl.detach_shader(prog, s);
                gl.delete_shader(s);
            }
            linked
        };
        if !linked {
            return false;
        }
        // SAFETY: see above (object creation and integer parameters only).
        unsafe {
            self.vao = gl.create_vertex_array().ok();
            for _ in 0..3 {
                let Ok(t) = gl.create_texture() else { return false };
                self.tex.push(t);
                gl.bind_texture(glow::TEXTURE_2D, Some(t));
                for (k, v) in [
                    (glow::TEXTURE_MIN_FILTER, glow::LINEAR),
                    (glow::TEXTURE_MAG_FILTER, glow::LINEAR),
                    (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE),
                    (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE),
                ] {
                    gl.tex_parameter_i32(glow::TEXTURE_2D, k, v as i32);
                }
            }
        }
        self.vao.is_some()
    }

    fn upload(&mut self, gl: &glow::Context, p: &Planes) {
        let (w, h) = (p.w as usize, p.h as usize);
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
        if w == 0 || h == 0 || p.bytes.len() < w * h + cw * ch * 2 {
            return;
        }
        let (y, rest) = p.bytes.split_at(w * h);
        let planes: Vec<(usize, usize, u32, u32, &[u8])> = if p.nv12 {
            vec![(w, h, glow::R8, glow::RED, y), (cw, ch, glow::RG8, glow::RG, &rest[..cw * ch * 2])]
        } else {
            let (u, v) = rest.split_at(cw * ch);
            vec![(w, h, glow::R8, glow::RED, y), (cw, ch, glow::R8, glow::RED, u), (cw, ch, glow::R8, glow::RED, &v[..cw * ch])]
        };
        // SAFETY: see above. GL reads exactly pw*ph*(1 or 2) bytes per plane (unpack
        // alignment 1, no row length), and each slice was cut to that size above.
        unsafe {
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
            gl.pixel_store_i32(glow::UNPACK_ROW_LENGTH, 0);
            for (i, (pw, ph, internal, format, data)) in planes.into_iter().enumerate() {
                gl.active_texture(glow::TEXTURE0 + i as u32);
                gl.bind_texture(glow::TEXTURE_2D, Some(self.tex[i]));
                gl.tex_image_2d(
                    glow::TEXTURE_2D, 0, internal as i32, pw as i32, ph as i32, 0, format, glow::UNSIGNED_BYTE,
                    glow::PixelUnpackData::Slice(Some(data)),
                );
            }
            gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 4);
            gl.active_texture(glow::TEXTURE0);
        }
        self.shown = Some((p.nv12, p.bt709, p.full_range));
    }

    fn draw(&mut self, gl: &glow::Context) {
        if self.failed {
            return;
        }
        if self.program.is_none() && !self.build(gl) {
            self.failed = true;
            return;
        }
        if let Some(p) = self.pending.take() {
            self.upload(gl, &p);
        }
        let (Some((nv12, bt709, full)), Some(prog)) = (self.shown, self.program) else { return };
        // SAFETY: see above. Draws 4 vertices generated in the shader (no buffers);
        // egui_glow re-applies its own state after the callback.
        unsafe {
            gl.use_program(Some(prog));
            for (i, name) in ["t_y", "t_u", "t_v"].iter().enumerate() {
                gl.active_texture(glow::TEXTURE0 + i as u32);
                gl.bind_texture(glow::TEXTURE_2D, Some(self.tex[i]));
                gl.uniform_1_i32(gl.get_uniform_location(prog, name).as_ref(), i as i32);
            }
            for (name, on) in [("nv12", nv12), ("bt709", bt709), ("full_range", full)] {
                gl.uniform_1_i32(gl.get_uniform_location(prog, name).as_ref(), on as i32);
            }
            gl.disable(glow::BLEND);
            gl.bind_vertex_array(self.vao);
            gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
            gl.bind_vertex_array(None);
            gl.active_texture(glow::TEXTURE0);
            gl.enable(glow::BLEND);
        }
    }
}
