# Private compositor: nothing here reaches the desk session.
export HTS_RT=${HTS_RT:-$HOME/.cache/hts/r-p0}
mkdir -p $HTS_RT; chmod 700 $HTS_RT
export XDG_RUNTIME_DIR=$HTS_RT
export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
export HYPRLAND_NO_SD_VARS=1 HYPRLAND_NO_SD_NOTIFY=1 HYPRLAND_NO_CRASHREPORTER=1
export LIBSEAT_BACKEND=seatd
unset DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_SESSION_ID
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDER_DRM_DEVICE=/dev/dri/renderD129
export SWAY=$HOME/.cache/hts/tmp/sway/root/usr
export LD_SWAY=$SWAY/lib
export WAYLAND_DISPLAY=wayland-1
export SWAYSOCK=$(ls $XDG_RUNTIME_DIR/sway-ipc*.sock 2>/dev/null | head -1)
swaym() { LD_LIBRARY_PATH=$LD_SWAY $SWAY/bin/swaymsg "$@"; }
