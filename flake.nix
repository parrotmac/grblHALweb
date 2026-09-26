{
  description = "grblHAL compiled to WebAssembly: a machine simulator web app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # wasm toolchain
            emscripten
            binaryen # wasm-opt, wasm-dis for inspecting output
            wabt # wasm2wat, wasm-objdump

            # build
            cmake
            ninja
            gnumake
            pkg-config
            gnupatch # applies patches/core to the build copy of grblHAL core

            # native toolchain for host-side tests of the driver
            clang
            clang-tools # clangd, clang-format

            # web viewer + headless runs
            nodejs_24
            pnpm

            # misc
            python3 # emscripten tooling, simple http server
            git
          ];

          shellHook = ''
            # The emscripten package lives in the read-only nix store; point its
            # cache (compiled libc, ports, etc.) somewhere writable.
            export EM_CACHE="$PWD/.emscripten_cache"
            mkdir -p "$EM_CACHE"
            if [ ! -e "$EM_CACHE/sysroot" ]; then
              cp -r --no-preserve=mode ${pkgs.emscripten}/share/emscripten/cache/. "$EM_CACHE/" 2>/dev/null || true
            fi

            echo "grblHALweb dev shell: $(emcc --version | head -n1)"
          '';
        };
      });
}
