#!/usr/bin/env python3
"""A raw disk image (here: the ISO xorrisofs makes of Harbor.app) as a compressed macOS disk image
(UDIF, zlib chunks: what `hdiutil convert -format UDZO` gives), on Linux, with nothing but Python:

    udzo.py IN.iso OUT.dmg

The layout follows Apple's UDIF: the compressed chunks, a "blkx" table ("mish") describing them in an
XML property list, and the 512-byte "koly" trailer, all big-endian, with CRC32 checksums."""
import plistlib, struct, sys, uuid, zlib

SECTOR = 512
CHUNK_SECTORS = 2048  # 1 MiB of the image per chunk
ZLIB, ZERO, END = 0x80000005, 0x00000000, 0xFFFFFFFF
# The blkx table's partition number for an image without a partition map (hdiutil -layout NONE).
WHOLE_DISK = 0xFFFFFFFE
CRC32 = 2


def checksum(value: int) -> bytes:
    # UDIFChecksum: type, size in bits, then 32 words (only the first used).
    return struct.pack(">II", CRC32, 32) + struct.pack(">I", value) + bytes(124)


def convert(src: str, dst: str) -> None:
    raw = open(src, "rb").read()
    if len(raw) % SECTOR:
        raw += bytes(SECTOR - len(raw) % SECTOR)
    sectors = len(raw) // SECTOR
    data = bytearray()
    chunks = []
    crc = 0
    for first in range(0, sectors, CHUNK_SECTORS):
        n = min(CHUNK_SECTORS, sectors - first)
        part = raw[first * SECTOR:(first + n) * SECTOR]
        crc = zlib.crc32(part, crc)
        if part.count(0) == len(part):
            chunks.append((ZERO, first, n, len(data), 0))
            continue
        z = zlib.compress(part, 9)
        chunks.append((ZLIB, first, n, len(data), len(z)))
        data += z
    chunks.append((END, sectors, 0, len(data), 0))

    mish = struct.pack(">4sIQQQII", b"mish", 1, 0, sectors, 0, CHUNK_SECTORS + 8, WHOLE_DISK) + bytes(24)
    mish += checksum(crc) + struct.pack(">I", len(chunks))
    for kind, first, n, off, length in chunks:
        mish += struct.pack(">IIQQQQ", kind, 0, first, n, off, length)

    # What hdiutil writes beside the table: a "plst" of 1032 bytes, two of them set.
    plst = bytearray(1032)
    plst[517] = plst[519] = 1
    plist = plistlib.dumps({
        "resource-fork": {
            "blkx": [{
                "Attributes": "0x0050",
                "CFName": "whole disk (Apple_ISO : 0)",
                "Data": mish,
                "ID": "0",
                "Name": "whole disk (Apple_ISO : 0)",
            }],
            "plst": [{"Attributes": "0x0050", "Data": bytes(plst), "ID": "0", "Name": ""}],
        },
    })

    master = zlib.crc32(struct.pack(">I", crc))
    koly = struct.pack(">4sIII", b"koly", 4, 512, 1)
    koly += struct.pack(">QQQQQ", 0, 0, len(data), 0, 0)
    koly += struct.pack(">II", 0, 0) + uuid.uuid4().bytes
    koly += bytes(136)  # no data-fork checksum, as hdiutil leaves it
    koly += struct.pack(">QQ", len(data), len(plist)) + bytes(120)
    koly += checksum(master)
    koly += struct.pack(">IQ", 2, sectors) + bytes(12)
    assert len(koly) == 512, len(koly)

    with open(dst, "wb") as f:
        f.write(data)
        f.write(plist)
        f.write(koly)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: udzo.py IN OUT.dmg")
    convert(sys.argv[1], sys.argv[2])
