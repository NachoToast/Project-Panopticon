{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: {
    devShells.x86_64-linux.default = let
      pkgs = import nixpkgs {system = "x86_64-linux";};
    in
      pkgs.mkShell {
        packages = [
          pkgs.pnpm
          pkgs.prettier
          pkgs.nodejs-slim_latest
        ];
      };
  };
}
