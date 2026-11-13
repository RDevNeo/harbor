import { describe, expect, test } from "bun:test";
import { authApp, focusedClass, linuxFocus, macFocus, parseWinFocus } from "../src/screen/secure.ts";

describe("secure focus", () => {
  test("Windows: password fields and the credential and consent UI", () => {
    expect(parseWinFocus('{"ok":true,"password":true,"process":"chrome","cls":"","type":"ControlType.Edit"}')).toEqual({ state: "secure", what: "a password field (chrome)" });
    expect(parseWinFocus('{"ok":true,"password":false,"process":"CredentialUIBroker","cls":"","type":""}').state).toBe("secure");
    expect(parseWinFocus('{"ok":true,"password":false,"process":"consent","cls":"","type":""}').state).toBe("secure");
    expect(parseWinFocus('{"ok":true,"password":false,"process":"explorer","cls":"Credential Dialog Xaml Host","type":""}').state).toBe("secure");
    expect(parseWinFocus('{"ok":true,"password":false,"process":"notepad","cls":"Edit","type":"ControlType.Document"}')).toEqual({ state: "clear" });
    expect(parseWinFocus('{"ok":false,"error":"no focus"}')).toEqual({ state: "unknown", why: "no focus" });
    expect(parseWinFocus("garbage").state).toBe("unknown");
  });

  test("macOS: AXSecureTextField and SecurityAgent", () => {
    expect(macFocus("AXTextField", "AXSecureTextField", "Safari").state).toBe("secure");
    expect(macFocus("AXGroup", "", "SecurityAgent").state).toBe("secure");
    expect(macFocus("AXTextField", "", "coreautha").state).toBe("secure");
    expect(macFocus("AXTextArea", "", "TextEdit")).toEqual({ state: "clear" });
  });

  test("Linux: polkit agents, prompters and AT-SPI's password text", () => {
    expect(linuxFocus("hyprpolkitagent", "").state).toBe("secure");
    expect(linuxFocus("polkit-gnome-authentication-agent-1", "").state).toBe("secure");
    expect(linuxFocus("org.kde.polkit-kde-authentication-agent-1", "").state).toBe("secure");
    expect(linuxFocus("pinentry-qt", "").state).toBe("secure");
    expect(linuxFocus("firefox", "password-text Firefox")).toEqual({ state: "secure", what: "a password field (Firefox)" });
    expect(linuxFocus("", "text gcr-prompter").state).toBe("secure");
    expect(linuxFocus("kitty", "terminal kitty")).toEqual({ state: "clear" });
    expect(linuxFocus("kitty", "")).toEqual({ state: "clear" });
    expect(linuxFocus("", "").state).toBe("unknown");
    expect(authApp("linux", "")).toBe(false);
    expect(authApp("win32", "LogonUI.exe")).toBe(true);
  });

  test("the focused window's class from hyprctl, swaymsg and xdotool", () => {
    expect(focusedClass("hyprctl", '{"class":"hyprpolkitagent","title":"Authenticate"}')).toBe("hyprpolkitagent");
    expect(focusedClass("hyprctl", "{}")).toBe("");
    const tree = { nodes: [{ nodes: [{ focused: false, app_id: "kitty" }], floating_nodes: [{ focused: true, app_id: null, window_properties: { class: "Pinentry-gtk" } }] }] };
    expect(focusedClass("swaymsg", JSON.stringify(tree))).toBe("Pinentry-gtk");
    expect(focusedClass("swaymsg", "not json")).toBe("");
    expect(focusedClass("xdotool", "Polkit-gnome-authentication-agent-1\n")).toBe("Polkit-gnome-authentication-agent-1");
  });
});
