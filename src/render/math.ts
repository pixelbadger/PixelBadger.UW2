export type Mat4 = number[];

export function perspective(fy: number, asp: number, n: number, f: number): Mat4 {
  const t = 1 / Math.tan(fy / 2);
  return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0];
}

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!; o[c * 4 + r] = s; }
  return o;
}

/** View matrix from the eye and the forward/right/up basis. */
export function lookFrom(E: number[], F: number[], R: number[], U: number[]): Mat4 {
  const d = (v: number[]) => v[0]! * E[0]! + v[1]! * E[1]! + v[2]! * E[2]!;
  return [R[0]!, U[0]!, -F[0]!, 0, R[1]!, U[1]!, -F[1]!, 0, R[2]!, U[2]!, -F[2]!, 0, -d(R), -d(U), d(F), 1];
}
