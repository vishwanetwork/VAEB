declare module "snarkjs" {
  export namespace groth16 {
    function fullProve(
      input: any,
      wasmFile: string,
      zkeyFile: string
    ): Promise<{ proof: any; publicSignals: string[] }>;

    function verify(
      vkey: any,
      publicSignals: string[],
      proof: any
    ): Promise<boolean>;
  }
}
