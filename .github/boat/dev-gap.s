# The gap dev-link.sh puts after each of Harbor's objects: one aligned byte per section kind, kept
# by the linker ("R") whatever --gc-sections thinks, so the next object starts at a boundary.
.section .text.zzgap,"axR",@progbits
.p2align 14
nop
.section .rodata.zzgap,"aR",@progbits
.p2align 12
.byte 0
.section .data.rel.ro.zzgap,"awR",@progbits
.p2align 12
.byte 0
