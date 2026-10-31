# Before Harbor's first object: data growing in front of .rodata (.rela.dyn) stays there.
.section .rodata.zzfirst,"aR",@progbits
.p2align 16
.byte 0
