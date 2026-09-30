// All geometry samples palette-index textures, picks a LIGHT.DAT row by distance, then maps through PALS.DAT palette 0.

export const VS_WORLD = `#version 300 es
layout(location=0) in vec3 aP; layout(location=1) in vec2 aT; layout(location=2) in float aL;
uniform mat4 uVP; uniform vec3 uEye; out vec3 vT; out float vD;
void main(){ vT=vec3(aT,aL); vD=distance(aP,uEye); gl_Position=uVP*vec4(aP,1.); }`;

/** Billboards: centre + offset along the camera's right vector and world up. */
export const VS_SPRITE = `#version 300 es
layout(location=0) in vec3 aC; layout(location=1) in vec2 aO; layout(location=2) in vec2 aT; layout(location=3) in float aL;
uniform mat4 uVP; uniform vec3 uEye; uniform vec3 uRight; out vec3 vT; out float vD;
void main(){ vec3 p=aC+uRight*aO.x+vec3(0.,aO.y,0.); vT=vec3(aT,aL); vD=distance(p,uEye); gl_Position=uVP*vec4(p,1.); }`;

/** Models: the per-face shade is added to the light distance. */
export const VS_MODEL = VS_WORLD
  .replace('layout(location=2) in float aL;', 'layout(location=2) in float aL; layout(location=3) in float aS;')
  .replace('vD=distance(aP,uEye);', 'vD=distance(aP,uEye)+aS;');

export const FS = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uTex; uniform sampler2D uPal; uniform sampler2D uLight; uniform vec2 uLt; uniform int uAlpha;
in vec3 vT; in float vD; out vec4 o;
void main(){ int idx=int(texture(uTex,vT).r*255.+.5);
  if(uAlpha==1&&(idx==0||vD<0.3)) discard;
  int sh=clamp(int(vD*uLt.y+uLt.x),0,15);
  int m=int(texelFetch(uLight,ivec2(idx,sh),0).r*255.+.5);
  o=texelFetch(uPal,ivec2(m,0),0); }`;

/** Creatures sample their per-level 2D atlas instead of the texture array. */
export const FS_ATLAS = FS.replace('uniform sampler2DArray uTex', 'uniform sampler2D uTex').replace('texture(uTex,vT)', 'texture(uTex,vT.xy)');
