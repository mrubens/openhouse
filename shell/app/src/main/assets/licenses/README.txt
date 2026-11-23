Native programs in this app (lib/arm64-v8a/, from shell/app/src/main/jniLibs/arm64-v8a/ in the source)

These are Termux's builds, as Termux's aarch64 packages ship them. OpenHouse runs proot as a separate
program (it is executed, not linked into OpenHouse's code); talloc and libandroid-shmem are libraries proot loads.
Each keeps its own license, whose text is in this folder. The source of each is at the addresses below, with
Termux's build recipe and patches at https://github.com/termux/termux-packages/tree/master/packages/<package>.

libproot.so, libproot-loader.so
  PRoot 5.1.107.102 (Termux package "proot"; the version is printed in the binary)
  License: GPL-2.0-or-later. Text: proot-COPYING.txt
  Source: https://github.com/termux/proot/archive/v5.1.107.102.zip
          (sha256 30d12a6e2cc4147123756ff58edea262d3083bbc238c12d0ab9b39e3d1c40852)
  sha256 of the binaries as shipped:
    5c696646eab69390526238ed0ab2c432be8096609d40b3f7e521dc31f0b9f46f  libproot.so
    1da54355333cca3fb6ee10e3b82a24df24fb230c99241ce83809bf9e240609b5  libproot-loader.so

libtalloc.so
  talloc 2.5 (Termux package "libtalloc"; the binary reports 2.5, and Termux's 2.5 release is 2.5.0)
  License: LGPL-3.0-or-later. Texts: talloc-LGPL-3.0.txt and the GPL it builds on, talloc-GPL-3.0.txt
  Source: https://www.samba.org/ftp/talloc/talloc-2.5.0.tar.gz
          (sha256 912afa237510ae542a7733998eb18a12bcda35ab6729c8e2ddb43e8d0ebab007)
  sha256 as shipped: b0aeabc93ba41a5d820474884be04dd7894f270e0bfab4eb3b2a07f0df4d1bae  libtalloc.so

libandroid-shmem.so
  libandroid-shmem 0.7 (Termux package "libandroid-shmem"; the binary has no version string, 0.7 is Termux's
  release of it)
  License: BSD-3-Clause. Text: libandroid-shmem-LICENSE.txt
  Source: https://github.com/termux/libandroid-shmem/archive/refs/tags/v0.7.tar.gz
  sha256 as shipped: 0bd211431c1436f7fa8032b5f2a15b64c7dcd989dfef00d5388dd7085b8ce976  libandroid-shmem.so
