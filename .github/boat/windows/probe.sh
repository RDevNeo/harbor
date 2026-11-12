#!/bin/bash
# What a sandbox offers a Windows VM: KVM, CPUs, memory, disk, the tools, and the download speed
# from Microsoft's servers.
set -uo pipefail
echo "kernel: $(uname -r)  os: $(. /etc/os-release; echo "$PRETTY_NAME")"
ls -l /dev/kvm; [ -r /dev/kvm ] && [ -w /dev/kvm ] && echo "kvm: usable" || echo "kvm: NOT usable"
grep -c ^processor /proc/cpuinfo; grep -m1 'model name' /proc/cpuinfo; grep -m1 -o -w 'vmx\|svm' /proc/cpuinfo
grep -E 'MemTotal|MemAvailable' /proc/meminfo
df -h / "$HOME" /tmp | sort -u
cat /sys/module/kvm_intel/parameters/nested 2>/dev/null
for t in qemu-system-x86_64 qemu-img xorriso genisoimage docker sudo apt-get swtpm python3; do printf '%s: %s\n' "$t" "$(command -v $t || echo -)"; done
sudo -n true && echo "sudo: yes"
u=$(curl -sI 'https://go.microsoft.com/fwlink/?linkid=2289029&clcid=0x409&culture=en-us&country=us' | sed -n 's/^[Ll]ocation: //p' | tr -d '\r')
echo "iso: $u"
curl -sI "$u" | grep -i content-length
s=$(date +%s.%N); curl -s -r 0-524287999 -o /dev/null -w 'got %{size_download} bytes at %{speed_download} B/s\n' "$u"; e=$(date +%s.%N)
echo "500 MB in $(echo "$e - $s" | bc 2>/dev/null || python3 -c "print($e-$s)") s"
