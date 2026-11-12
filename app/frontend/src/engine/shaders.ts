// GLSL ES 3.00 (WebGL2) sources.
//
// Positions are camera-relative: world integer coordinates and floor(camera)
// are sent as ints (exact), subtracted in integer math, and only then is the
// fractional camera part removed in float. Precision no longer depends on the
// position on the grid, and quads sharing an edge produce bitwise-identical
// vertices (no seams).
import { OverlayStyle } from './overlay';

// `#version` must be the very first characters of the source
const HEADER = `#version 300 es
precision highp float;
precision highp int;
`;

/** Below this on-screen size (CSS px) the selection frame surrounds a square of this size instead */
export const SELECTION_MIN_PX = 2;

// ---------------------------------------------------------------------------
// Chunk quads: background, white chunks, palette-id chunks, downsampled chunks
// ---------------------------------------------------------------------------

/** Shared by the quad, ids and rgba programs: one quad of u_size world px at u_origin */
export const CHUNK_VERTEX_SHADER = `${HEADER}
uniform vec2 u_resolution;  // viewport, CSS px
uniform ivec2 u_camInt;     // floor(camera), world px
uniform vec2 u_camFrac;     // camera - floor(camera)
uniform float u_zoom;       // CSS px per world px
uniform ivec2 u_origin;     // quad origin, world px
uniform ivec2 u_size;       // quad size, world px

layout(location = 0) in vec2 a_corner; // unit quad corner: 0.0 or 1.0

out vec2 v_local;           // position inside the quad, world px

void main() {
    ivec2 local = ivec2(a_corner) * u_size;
    v_local = vec2(local);
    vec2 screen = (vec2(u_origin + local - u_camInt) - u_camFrac) * u_zoom + u_resolution * 0.5;
    vec2 clip = screen / u_resolution * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

// Uniforms and helpers shared by the chunk fragment shaders
const CHUNK_FRAGMENT_COMMON = `
uniform float u_zoom;       // CSS px per world px
uniform float u_dpr;        // device px per CSS px

in vec2 v_local;
out vec4 outColor;

const vec3 UNLOADED_A = vec3(0.8627, 0.8706, 0.8902); // #DCDEE3
const vec3 UNLOADED_B = vec3(0.9020, 0.9098, 0.9255); // #E6E8EC

// "Not loaded yet": diagonal stripes about 8 CSS px wide, fixed to the screen
// so they read as a placeholder rather than as pixel content
vec3 unloadedPattern() {
    float t = (gl_FragCoord.x + gl_FragCoord.y) / (8.0 * u_dpr);
    return fract(t * 0.5) < 0.5 ? UNLOADED_A : UNLOADED_B;
}

// Faint 1-device-pixel line on the left/top edge of every world pixel, faded in
// with the zoom. w = fwidth(v_local), taken by the caller in uniform control flow.
vec3 gridLines(vec3 color, vec2 w) {
    float a = smoothstep(6.0, 12.0, u_zoom);
    vec2 f = v_local - floor(v_local);
    return any(lessThan(f, w)) ? color * (1.0 - 0.15 * a) : color;
}
`;

/** Background (unloaded pattern) or loaded chunk without any painted pixel (white) */
export const QUAD_FRAGMENT_SHADER = `${HEADER}${CHUNK_FRAGMENT_COMMON}
uniform bool u_white;

void main() {
    vec2 w = fwidth(v_local);
    outColor = vec4(u_white ? gridLines(vec3(1.0), w) : unloadedPattern(), 1.0);
}
`;

/** Full-resolution chunk (lod 0): palette ids looked up in the palette texture */
export const IDS_FRAGMENT_SHADER = `${HEADER}${CHUNK_FRAGMENT_COMMON}
uniform highp usampler2D u_ids;     // R8UI, one palette id per world px
uniform highp sampler2D u_palette;  // 256x1 RGBA8, x = palette id
uniform bool u_loading;             // pages still arriving: id 0 means unknown, not empty

void main() {
    vec2 w = fwidth(v_local);
    ivec2 texel = clamp(ivec2(floor(v_local)), ivec2(0), textureSize(u_ids, 0) - 1);
    uint id = texelFetch(u_ids, texel, 0).r;
    if (u_loading && id == 0u) {
        outColor = vec4(unloadedPattern(), 1.0);
        return;
    }
    vec3 color = texelFetch(u_palette, ivec2(int(id), 0), 0).rgb;
    outColor = vec4(gridLines(color, w), 1.0);
}
`;

/** Downsampled chunk (lod >= 1): RGBA8, one texel per 2^u_lodShift world px */
export const RGBA_FRAGMENT_SHADER = `${HEADER}${CHUNK_FRAGMENT_COMMON}
uniform highp sampler2D u_colors;
uniform int u_lodShift;

void main() {
    vec2 w = fwidth(v_local);
    ivec2 p = max(ivec2(floor(v_local)), ivec2(0)) >> u_lodShift;
    ivec2 texel = min(p, textureSize(u_colors, 0) - 1);
    vec3 color = texelFetch(u_colors, texel, 0).rgb;
    outColor = vec4(gridLines(color, w), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Overlays: one instanced quad per entry of an OverlayBuffer
// ---------------------------------------------------------------------------

const STYLE_CONSTANTS = `
const int STYLE_PREVIEW = ${OverlayStyle.PREVIEW};
const int STYLE_PENDING = ${OverlayStyle.PENDING};
const int STYLE_SELECTION = ${OverlayStyle.SELECTION};
const int STYLE_BRUSH = ${OverlayStyle.BRUSH};
const int STYLE_HOVER = ${OverlayStyle.HOVER};
const float SELECTION_MIN_PX = ${SELECTION_MIN_PX.toFixed(1)};
`;

export const OVERLAY_VERTEX_SHADER = `${HEADER}${STYLE_CONSTANTS}
uniform vec2 u_resolution;  // viewport, CSS px
uniform ivec2 u_camInt;     // floor(camera), world px
uniform vec2 u_camFrac;     // camera - floor(camera)
uniform float u_zoom;       // CSS px per world px
uniform float u_ring;       // selection ring width, CSS px
uniform highp sampler2D u_palette;

layout(location = 0) in vec2 a_corner;   // unit quad corner: 0.0 or 1.0
layout(location = 1) in vec4 a_instance; // x, y (world px, integers), palette id, style

flat out int v_style;
flat out vec3 v_color;
out vec2 v_offset;          // from the pixel center, CSS px

void main() {
    ivec2 cell = ivec2(a_instance.xy);
    int style = int(a_instance.w);
    v_style = style;
    v_color = texelFetch(u_palette, ivec2(clamp(int(a_instance.z), 0, 255), 0), 0).rgb;

    vec2 screen;
    if (style == STYLE_SELECTION) {
        // Frame outside the pixel (or around a minimum-size square), +1 px of antialiasing room
        float ext = max(u_zoom, SELECTION_MIN_PX) * 0.5 + 2.0 * u_ring + 1.0;
        vec2 center = (vec2(cell - u_camInt) - u_camFrac + 0.5) * u_zoom + u_resolution * 0.5;
        v_offset = (a_corner * 2.0 - 1.0) * ext;
        screen = center + v_offset;
    } else {
        // Same expression as the chunk quads: the overlay covers its pixel exactly
        screen = (vec2(cell + ivec2(a_corner) - u_camInt) - u_camFrac) * u_zoom + u_resolution * 0.5;
        v_offset = (a_corner - 0.5) * u_zoom;
    }
    vec2 clip = screen / u_resolution * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

export const OVERLAY_FRAGMENT_SHADER = `${HEADER}${STYLE_CONSTANTS}
uniform float u_zoom;       // CSS px per world px
uniform float u_dpr;        // device px per CSS px
uniform float u_ring;       // selection ring width, CSS px

flat in int v_style;
flat in vec3 v_color;
in vec2 v_offset;

out vec4 outColor;

const vec3 FRAME_DARK = vec3(0.0667); // #111111

void main() {
    float px = 1.0 / u_dpr;                          // one device pixel, CSS px
    float d = max(abs(v_offset.x), abs(v_offset.y)); // square distance from the pixel center

    if (v_style == STYLE_PREVIEW) {
        outColor = vec4(v_color, 1.0);
    } else if (v_style == STYLE_PENDING) {
        // Static stripes about 4 CSS px wide, faded in once the pixel is big
        // enough to show them: reads as "not committed yet" without animation
        float t = (gl_FragCoord.x + gl_FragCoord.y) / (4.0 * u_dpr);
        float stripe = step(0.5, fract(t * 0.5)) * smoothstep(6.0, 12.0, u_zoom);
        float luma = dot(v_color, vec3(0.299, 0.587, 0.114));
        vec3 shade = mix(v_color, luma > 0.5 ? vec3(0.0) : vec3(1.0), 0.3);
        outColor = vec4(mix(v_color, shade, stripe), 0.8);
    } else if (v_style == STYLE_SELECTION) {
        // White inner ring + dark outer ring, just outside the pixel so its
        // content stays visible; each edge gets a 1-device-pixel ramp (antialiasing)
        float inner = max(u_zoom, SELECTION_MIN_PX) * 0.5;
        float alpha = clamp((d - inner) / px + 0.5, 0.0, 1.0) * clamp((inner + 2.0 * u_ring - d) / px + 0.5, 0.0, 1.0);
        float dark = clamp((d - inner - u_ring) / px + 0.5, 0.0, 1.0);
        outColor = vec4(mix(vec3(1.0), FRAME_DARK, dark), alpha);
    } else if (v_style == STYLE_BRUSH) {
        outColor = vec4(v_color, 0.55);
    } else if (v_style == STYLE_HOVER) {
        // 1 CSS px (at least 1 device px) dark outline just inside the pixel
        float inner = u_zoom * 0.5 - max(1.0, px);
        outColor = vec4(0.0, 0.0, 0.0, 0.45 * clamp((d - inner) / px + 0.5, 0.0, 1.0));
    } else {
        discard;
    }
}
`;
