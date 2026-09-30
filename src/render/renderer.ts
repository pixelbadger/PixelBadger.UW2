import type { GameData } from '../data/gamedata';
import type { Game } from '../game/game';
import { eye, viewBasis } from '../game/picking';
import { critterQuads } from '../world/creatures';
import type { Level } from '../world/level';
import { lookFrom, mul, perspective, type Mat4 } from './math';
import { FS, FS_ATLAS, VS_MODEL, VS_SPRITE, VS_WORLD } from './shaders';

/** Light sources: name, light-table offset, distance falloff. */
export const LIGHTS: [string, number, number][] = [['Candle', -1, 4.2], ['Torch', -2, 2.9], ['Lantern', -3, 2.1], ['Daylight', 0, 0.25]];

type Program = WebGLProgram & { U: Record<string, WebGLUniformLocation | null> };

/** A vertex buffer that keeps its VAO and is refilled in place. Strides: 6 world, 7 model, 8 billboard. */
class Mesh {
  readonly vao: WebGLVertexArrayObject;
  readonly buf: WebGLBuffer;
  n = 0;
  constructor(private gl: WebGL2RenderingContext, readonly stride: 6 | 7 | 8) {
    this.vao = gl.createVertexArray()!; this.buf = gl.createBuffer()!;
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const layout: [number, number, number][] = stride === 7 ? [[0, 3, 0], [1, 2, 12], [2, 1, 20], [3, 1, 24]]
      : stride === 6 ? [[0, 3, 0], [1, 2, 12], [2, 1, 20]] : [[0, 3, 0], [1, 2, 12], [2, 2, 20], [3, 1, 28]];
    for (const [l, n, o] of layout) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, n, gl.FLOAT, false, stride * 4, o); }
    gl.bindVertexArray(null);
  }
  set(data: number[], usage: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), usage);
    this.n = data.length / this.stride;
  }
}

/**
 * WebGL2 renderer. One R8 TEXTURE_2D_ARRAY holds every 64x64 image (unit 0); palette on unit 1, light table on unit 2,
 * the level's creature atlas on unit 3. Nearest filtering throughout. Meshes mirror the LevelScene's parts and are
 * re-uploaded only when that part's version changes; creatures are rebuilt every frame.
 */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private progW: Program; private progS: Program; private progM: Program; private progC: Program;
  private meshes: Record<'world' | 'fixed' | 'dynamic' | 'models' | 'dynModels' | 'sprites' | 'critters', Mesh>;
  private critTex: WebGLTexture | null = null;
  private synced = { level: null as Level | null, world: -1, fixed: -1, dynamic: -1, sprites: -1, critters: -1 };
  lightIdx = 2;
  chunky = true;

  constructor(readonly canvas: HTMLCanvasElement, D: GameData) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('This browser has no WebGL 2, which the engine needs.');
    this.gl = gl;
    this.progW = this.program(VS_WORLD, FS); this.progS = this.program(VS_SPRITE, FS); this.progM = this.program(VS_MODEL, FS); this.progC = this.program(VS_SPRITE, FS_ATLAS);
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    if (D.LAYERS > maxLayers) throw new Error(`This GPU allows ${maxLayers} texture layers; the game needs ${D.LAYERS}.`);
    const texA = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, texA);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, 64, 64, D.LAYERS, 0, gl.RED, gl.UNSIGNED_BYTE, D.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT]] as const) gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, v);
    const t2 = (unit: number, w: number, h: number, fmt: number, ifmt: number, data: Uint8Array) => {
      const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    t2(1, 256, 1, gl.RGBA, gl.RGBA8, D.pal); t2(2, 256, 16, gl.RED, gl.R8, D.light);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    this.meshes = { world: new Mesh(gl, 6), fixed: new Mesh(gl, 6), dynamic: new Mesh(gl, 6), models: new Mesh(gl, 7), dynModels: new Mesh(gl, 7), sprites: new Mesh(gl, 8), critters: new Mesh(gl, 8) };
  }

  private program(vs: string, fs: string): Program {
    const gl = this.gl, p = gl.createProgram()! as Program;
    for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const sh = gl.createShader(t)!;
      gl.shaderSource(sh, s); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
      gl.attachShader(p, sh);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    p.U = {};
    for (const n of ['uVP', 'uEye', 'uRight', 'uTex', 'uPal', 'uLight', 'uLt', 'uAlpha']) p.U[n] = gl.getUniformLocation(p, n);
    return p;
  }

  /** Uploads whichever parts of the level's scene changed since the last frame. */
  private sync(game: Game): void {
    const gl = this.gl, L = game.L, sc = L.scene, v = sc.version, s = this.synced, M = this.meshes;
    if (s.level !== L) { s.level = L; s.world = s.fixed = s.dynamic = s.sprites = s.critters = -1; }
    if (s.world !== v.world) { M.world.set(sc.world, gl.STATIC_DRAW); s.world = v.world; }
    if (s.fixed !== v.fixed) { M.fixed.set(sc.fixed.mesh, gl.STATIC_DRAW); M.models.set(sc.fixed.models, gl.STATIC_DRAW); s.fixed = v.fixed; }
    if (s.dynamic !== v.dynamic) { M.dynamic.set(sc.dynamic.mesh, gl.DYNAMIC_DRAW); M.dynModels.set(sc.dynamic.models, gl.DYNAMIC_DRAW); s.dynamic = v.dynamic; }
    if (s.sprites !== v.sprites) { M.sprites.set(sc.sprites.mesh, gl.DYNAMIC_DRAW); s.sprites = v.sprites; }
    if (s.critters !== v.critters) {
      const a = game.atlas;
      if (a) {
        gl.activeTexture(gl.TEXTURE3);
        if (!this.critTex) this.critTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.critTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, a.AW, a.AH, 0, gl.RED, gl.UNSIGNED_BYTE, a.px);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.activeTexture(gl.TEXTURE0);
      }
      s.critters = v.critters;
    }
  }

  /** Draws the view (320x200-style 200-line "chunky" mode upscales pixelated via CSS). Records the view for picking. */
  render(game: Game): void {
    const gl = this.gl, cv = this.canvas, P = game.pose;
    const dpr = window.devicePixelRatio || 1, cw = cv.clientWidth || 1, ch = cv.clientHeight || 1;
    const h = this.chunky ? 200 : Math.round(ch * Math.min(dpr, 2)), w = Math.max(1, Math.round((h * cw) / ch));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    this.sync(game);
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const asp = w / h, fovY = asp >= 1 ? 1.05 : Math.min(1.9, 2 * Math.atan(Math.tan(0.62) / asp));
    game.view = { aspect: asp, fovY };
    const E = eye(game), { F, R, U } = viewBasis(P.yaw, P.pitch);
    const VP = mul(perspective(fovY, asp, 0.03, 80), lookFrom(E, F, R, U)), Lt = LIGHTS[this.lightIdx]!, M = this.meshes;
    const passes: [Program, Mesh, number, number][] = [[this.progW, M.world, 0, 0], [this.progW, M.fixed, 1, 0], [this.progW, M.dynamic, 1, 0], [this.progM, M.models, 0, 0], [this.progM, M.dynModels, 0, 0], [this.progS, M.sprites, 1, 0]];
    for (const [p, mesh, alpha, unit] of passes) this.draw(p, mesh, VP, E, Lt, alpha, unit, P.yaw);
    const a = game.atlas;
    if (a && game.L.critters.length) {
      M.critters.set(critterQuads(game.L, a, P.x, -P.z, performance.now() / 1000), gl.DYNAMIC_DRAW);
      this.draw(this.progC, M.critters, VP, E, Lt, 1, 3, P.yaw);
    }
  }

  private draw(p: Program, mesh: Mesh, VP: Mat4, E: number[], Lt: [string, number, number], alpha: number, unit: number, yaw: number): void {
    if (!mesh.n) return;
    const gl = this.gl;
    gl.useProgram(p);
    gl.uniformMatrix4fv(p.U.uVP!, false, VP); gl.uniform3fv(p.U.uEye!, E);
    if (p.U.uRight) gl.uniform3f(p.U.uRight, Math.cos(yaw), 0, Math.sin(yaw));
    gl.uniform1i(p.U.uTex!, unit); gl.uniform1i(p.U.uPal!, 1); gl.uniform1i(p.U.uLight!, 2); gl.uniform2f(p.U.uLt!, Lt[1], Lt[2]); gl.uniform1i(p.U.uAlpha!, alpha);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.n);
  }
}
