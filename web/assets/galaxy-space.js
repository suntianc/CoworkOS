const TAU = Math.PI * 2;
export const DEFAULT_GALAXY_VIEW = Object.freeze({ tilt: 0.76, roll: -0.32 });

// Layered value noise gives the dust irregular patches rather than repeating bands.
function cloudTexture(x, y, broad = false) {
  const hash = (a, b) => {
    const value = Math.sin(a * 127.1 + b * 311.7 + 53.8) * 43758.5453;
    return value - Math.floor(value);
  };
  const noise = (a, b) => {
    const ix = Math.floor(a),
      iy = Math.floor(b);
    const fx = a - ix,
      fy = b - iy;
    const u = fx * fx * (3 - 2 * fx),
      v = fy * fy * (3 - 2 * fy);
    const lower = hash(ix, iy) * (1 - u) + hash(ix + 1, iy) * u;
    const upper = hash(ix, iy + 1) * (1 - u) + hash(ix + 1, iy + 1) * u;
    return lower * (1 - v) + upper * v;
  };
  if (broad) return noise(x * 1.2 + 4.7, y * 1.2 - 2.3);
  const warp = noise(x * 2.3 + 17, y * 2.3 - 9);
  const a = x * 4.1 + warp * 2.4,
    b = y * 4.1 - warp * 1.7;
  const value = 0.55 * noise(a, b) + 0.3 * noise(a * 2.7 + 8, b * 2.7 - 3) + 0.15 * noise(a * 7.3, b * 7.3);
  return Math.max(0, Math.min(1, (value - 0.3) * 2.5));
}

/** A deterministic volume of stars, dust and a silver galactic bulge. */
export function createGalaxyParticles() {
  let seed = 7538;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(0.00001, random()))) * Math.cos(TAU * random());
  const particles = [];
  const palettes = [
    [0.78, 0.84, 0.9],
    [0.9, 0.93, 0.97],
    [1, 0.9, 0.77],
    [0.72, 0.76, 0.81]
  ];
  for (let i = 0; i < 6800; i++) {
    const bulge = i >= 5300 && i < 6350;
    const field = i >= 6350;
    const radius = bulge ? Math.abs(normal()) * 0.15 : 0.09 + Math.pow(random(), 0.65) * 1.05;
    const arm = i % 4;
    const angle =
      field || bulge ? random() * TAU : (arm * TAU) / 4 + radius * 4.65 + normal() * (0.035 + radius * 0.06);
    const spread = bulge ? 0.01 : field ? 0.06 : 0.019 + radius * 0.018;
    const colorRoll = random();
    const color = bulge
      ? [0.81, 0.85, 0.9]
      : palettes[colorRoll < 0.15 ? 2 : colorRoll < 0.27 ? 3 : colorRoll < 0.7 ? 0 : 1];
    const bright = random() > 0.985;
    particles.push({
      x: Math.cos(angle) * radius + normal() * spread,
      y: Math.sin(angle) * radius + normal() * spread,
      z: normal() * (bulge ? 0.085 : field ? 0.13 : 0.023),
      color,
      alpha: ((field ? 0.42 : 0.48) + random() * 0.48) * (bulge ? 0.82 : 1),
      size: bright ? 18 + random() * 11 : (field ? 5 : 3.8) + Math.pow(random(), 3) * 6,
      phase: random() * TAU,
      kind: 1
    });
  }
  // Soft, overlapping volumes follow the spiral arms, giving the disc depth
  // without an opaque painted surface or a hard-edged sphere in the centre.
  for (let i = 0; i < 160; i++) {
    const radius = 0.13 + random() * 0.96;
    const angle = ((i % 4) * TAU) / 4 + radius * 4.65 + normal() * 0.08;
    particles.unshift({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      z: normal() * 0.035,
      color: i % 3 ? [0.39, 0.43, 0.48] : [0.57, 0.6, 0.65],
      alpha: 0.025 + random() * 0.025,
      size: 20 + random() * 35,
      phase: 0,
      kind: 0
    });
  }
  particles.unshift({
    x: 0,
    y: 0,
    z: 0,
    color: [0.68, 0.72, 0.78],
    alpha: 0.26,
    size: 178,
    phase: 0,
    kind: 0
  });
  for (const particle of particles) {
    particle.tint = cloudTexture(particle.x, particle.y);
    particle.hue = cloudTexture(particle.x, particle.y, true);
  }
  return particles;
}

export function galaxyCamera(
  width,
  height,
  tilt = DEFAULT_GALAXY_VIEW.tilt,
  roll = DEFAULT_GALAXY_VIEW.roll
) {
  return { width, height, tilt, roll, scale: Math.min(width * 0.435, height * 0.445), distance: 4.2 };
}

/** The same perspective transform is used by the GPU, fallback and buttons. */
export function projectGalaxyPoint(point, camera, spin = 0) {
  const cs = Math.cos(spin),
    ss = Math.sin(spin);
  const x = point.x * cs - point.y * ss;
  const y = point.x * ss + point.y * cs;
  const ct = Math.cos(camera.tilt),
    st = Math.sin(camera.tilt);
  const depth = y * st + point.z * ct;
  const tiltedY = y * ct - point.z * st;
  const cr = Math.cos(camera.roll),
    sr = Math.sin(camera.roll);
  const zoom = camera.distance / (camera.distance - depth);
  return {
    x: camera.width / 2 + (x * cr - tiltedY * sr) * camera.scale * zoom,
    y: camera.height * 0.48 + (x * sr + tiltedY * cr) * camera.scale * zoom,
    zoom,
    depth
  };
}

export function orbitalPoint(orbit, angle) {
  const radius = (orbit.width / 100) * 0.97;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
    z: Math.sin(angle) * 0.045 * Math.sin((orbit.tilt * Math.PI) / 180)
  };
}

const vertexShader = `
attribute vec3 a_position;
attribute vec4 a_color;
attribute float a_size;
attribute float a_phase;
attribute float a_kind;
attribute float a_tint;
attribute float a_hue;
uniform vec2 u_viewport;
uniform vec2 u_camera;
uniform float u_scale;
uniform float u_density;
uniform float u_spin;
uniform float u_time;
varying vec4 v_color;
varying float v_kind;
varying float v_tint;
varying float v_hue;
void main() {
  float cs = cos(u_spin), ss = sin(u_spin);
  vec3 p = vec3(a_position.x * cs - a_position.y * ss, a_position.x * ss + a_position.y * cs, a_position.z);
  float ct = cos(u_camera.x), st = sin(u_camera.x);
  float depth = p.y * st + p.z * ct;
  float py = p.y * ct - p.z * st;
  float cr = cos(u_camera.y), sr = sin(u_camera.y);
  float zoom = 4.2 / (4.2 - depth);
  vec2 xy = vec2(p.x * cr - py * sr, p.x * sr + py * cr) * u_scale * zoom;
  gl_Position = vec4(2.0 * xy.x / u_viewport.x, .04 - 2.0 * xy.y / u_viewport.y, 0.0, 1.0);
  gl_PointSize = max(1.0, a_size * u_density * zoom);
  float shimmer = a_kind > .5 ? .92 + .08 * sin(u_time * .8 + a_phase) : 1.0;
  v_color = vec4(a_color.rgb, a_color.a * shimmer);
  v_kind = a_kind;
  v_tint = a_tint;
  v_hue = a_hue;
}`;

const fragmentShader = `
precision mediump float;
uniform float u_light;
varying vec4 v_color;
varying float v_kind;
varying float v_tint;
varying float v_hue;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float edge = 1.0 - smoothstep(.65, 1.0, r2);
  float hot = exp(-r2 * (v_kind > 1.5 ? 130.0 : 65.0));
  float glow = exp(-r2 * (v_kind > 1.5 ? 16.0 : 6.5)) * (v_kind > 1.5 ? .08 : .20);
  float rays = (exp(-abs(p.x) * 75.0 - abs(p.y) * 7.0) + exp(-abs(p.y) * 75.0 - abs(p.x) * 7.0)) * .13;
  if (v_kind > 1.5) {
    rays = (exp(-abs(p.x) * 100.0 - abs(p.y) * 4.5) + exp(-abs(p.y) * 100.0 - abs(p.x) * 4.5)) * .85;
  }
  vec3 night = mix(v_color.rgb, vec3(.74, .80, .88), .12);
  if (v_kind < 1.5) {
    night = mix(vec3(.55, .34, .45), vec3(.43, .50, .66), smoothstep(.2, .8, v_hue));
  }
  float brightness = v_kind < 1.5 ? mix(.32 + .30 * v_tint, .68 + .18 * v_tint, u_light) : 1.0;
  vec3 day = v_kind < 1.5
    ? mix(vec3(.65, .48, .67), vec3(.68, .79, .91), smoothstep(.2, .8, v_hue))
    : vec3(.45, .62, .82);
  vec3 ink = mix(night, day, u_light);
  if (v_kind < .5) {
    gl_FragColor = vec4(ink, v_color.a * brightness * exp(-r2 * 3.8) * edge);
  } else {
    vec3 color = mix(ink, mix(vec3(.98, .985, 1.0), vec3(.45, .62, .82), u_light), hot * (v_kind > 1.5 ? .75 : 0.0));
    gl_FragColor = vec4(color, v_color.a * brightness * min(1.0, hot * (v_kind > 1.5 ? 1.7 : 1.0) + glow + rays) * edge);
  }
}`;

function packParticles(particles) {
  return new Float32Array(
    particles.flatMap((p) => [
      p.x,
      p.y,
      p.z,
      ...p.color,
      p.alpha,
      p.size,
      p.phase,
      p.kind,
      p.tint ?? 0,
      p.hue ?? 0
    ])
  );
}

function webglPainter(canvas, particles, onRestored) {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: "low-power"
  });
  if (!gl) return null;
  let program, cloud, members, locations, attributes;
  let lost = false;
  function initialize() {
    const shaders = [
      [gl.VERTEX_SHADER, vertexShader],
      [gl.FRAGMENT_SHADER, fragmentShader]
    ].map(([type, source]) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    });
    program = gl.createProgram();
    shaders.forEach((shader) => gl.attachShader(program, shader));
    gl.linkProgram(program);
    shaders.forEach((shader) => gl.deleteShader(shader));
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    locations = Object.fromEntries(
      ["viewport", "camera", "scale", "density", "spin", "time", "light"].map((key) => [
        key,
        gl.getUniformLocation(program, `u_${key}`)
      ])
    );
    let offset = 0;
    attributes = [
      ["position", 3],
      ["color", 4],
      ["size", 1],
      ["phase", 1],
      ["kind", 1],
      ["tint", 1],
      ["hue", 1]
    ].map(([name, size]) => {
      const value = { location: gl.getAttribLocation(program, `a_${name}`), size, offset: offset * 4 };
      offset += size;
      return value;
    });
    cloud = gl.createBuffer();
    members = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cloud);
    gl.bufferData(gl.ARRAY_BUFFER, packParticles(particles), gl.STATIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.clearColor(16 / 255, 17 / 255, 20 / 255, 1);
  }
  function bind(buffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (const { location, size, offset } of attributes) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 48, offset);
    }
  }
  initialize();
  const contextLost = (event) => {
    event.preventDefault();
    lost = true;
  };
  const contextRestored = () => {
    lost = false;
    initialize();
    onRestored();
  };
  canvas.addEventListener("webglcontextlost", contextLost);
  canvas.addEventListener("webglcontextrestored", contextRestored);
  return {
    type: "webgl",
    draw(camera, time, stars) {
      if (lost) return;
      const light = document.documentElement.dataset.theme === "light";
      gl.blendFunc(gl.SRC_ALPHA, light ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
      gl.clearColor(...(light ? [245 / 255, 245 / 255, 247 / 255, 1] : [16 / 255, 17 / 255, 20 / 255, 1]));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform1f(locations.light, light ? 1 : 0);
      gl.uniform2f(locations.viewport, camera.width, camera.height);
      gl.uniform2f(locations.camera, camera.tilt, camera.roll);
      gl.uniform1f(locations.scale, camera.scale);
      gl.uniform1f(locations.density, (canvas.width / camera.width) * Math.min(1.25, camera.width / 395));
      gl.uniform1f(locations.time, time);
      gl.uniform1f(locations.spin, time * 0.014);
      bind(cloud);
      gl.drawArrays(gl.POINTS, 0, particles.length);
      gl.uniform1f(locations.spin, 0);
      bind(members);
      gl.bufferData(gl.ARRAY_BUFFER, packParticles(stars), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, stars.length);
    },
    destroy() {
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      gl.deleteBuffer(cloud);
      gl.deleteBuffer(members);
      gl.deleteProgram(program);
    }
  };
}

// The fallback uses the same volume and perspective, including drag rotation.
// Glow sprites are cached, avoiding thousands of new gradients each frame.
function canvasPainter(canvas, particles) {
  const context = canvas.getContext("2d", { alpha: false });
  const sprites = new Map();
  function sprite(p) {
    const light = document.documentElement.dataset.theme === "light";
    const cloudTint = Math.round((p.hue ?? 0) * 16) / 16;
    const key = `${light}:${p.color.join(",")}:${p.kind}:${cloudTint}`;
    if (sprites.has(key)) return sprites.get(key);
    const tile = document.createElement("canvas");
    tile.width = tile.height = 64;
    const brush = tile.getContext("2d");
    const gradient = brush.createRadialGradient(32, 32, 0, 32, 32, 32);
    const nightColor = p.color.map((v, i) => {
      const base = v * 0.88 + [0.74, 0.8, 0.88][i] * 0.12;
      if (p.kind > 1.5) return base;
      const blend = Math.max(0, Math.min(1, (cloudTint - 0.2) / 0.6));
      const smooth = blend * blend * (3 - 2 * blend);
      const pink = light ? [0.65, 0.48, 0.67] : [0.55, 0.34, 0.45];
      const blue = light ? [0.68, 0.79, 0.91] : [0.43, 0.5, 0.66];
      return pink[i] * (1 - smooth) + blue[i] * smooth;
    });
    const color = p.color
      .map((v, i) => Math.round((light && p.kind > 1.5 ? [0.45, 0.62, 0.82][i] : nightColor[i]) * 255))
      .join(",");
    if (p.kind) {
      gradient.addColorStop(0, p.kind > 1.5 ? (light ? "#739ed1" : "#ffffff") : `rgba(${color},.95)`);
      gradient.addColorStop(0.09, `rgba(${color},.9)`);
      gradient.addColorStop(0.23, `rgba(${color},.23)`);
    } else gradient.addColorStop(0, `rgba(${color},.9)`);
    gradient.addColorStop(0.5, `rgba(${color},${p.kind ? ".06" : ".25"})`);
    gradient.addColorStop(1, `rgba(${color},0)`);
    brush.fillStyle = gradient;
    brush.fillRect(0, 0, 64, 64);
    if (p.kind > 1.5) {
      brush.clearRect(0, 0, 64, 64);
      brush.fillStyle = gradient;
      brush.fillRect(23, 23, 18, 18);
      for (const vertical of [false, true]) {
        const beam = brush.createLinearGradient(
          vertical ? 32 : 3,
          vertical ? 3 : 32,
          vertical ? 32 : 61,
          vertical ? 61 : 32
        );
        beam.addColorStop(0, `rgba(${color},0)`);
        beam.addColorStop(0.5, light ? "#739ed1" : "#ffffff");
        beam.addColorStop(1, `rgba(${color},0)`);
        brush.fillStyle = beam;
        brush.fillRect(vertical ? 31.5 : 3, vertical ? 3 : 31.5, vertical ? 1 : 58, vertical ? 58 : 1);
      }
    }
    sprites.set(key, tile);
    return tile;
  }
  return {
    type: "canvas",
    draw(camera, time, stars) {
      const density = canvas.width / camera.width;
      context.setTransform(density, 0, 0, density, 0, 0);
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      const light = document.documentElement.dataset.theme === "light";
      context.fillStyle = light ? "#f5f5f7" : "#101114";
      context.fillRect(0, 0, camera.width, camera.height);
      context.globalCompositeOperation = light ? "source-over" : "lighter";
      const paint = (p, spin) => {
        const position = projectGalaxyPoint(p, camera, spin);
        const size = p.size * position.zoom * Math.min(1.25, camera.width / 395);
        context.globalAlpha =
          p.alpha *
          (0.92 + 0.08 * Math.sin(time * 0.8 + p.phase)) *
          (p.kind < 1.5 ? (light ? 0.68 + 0.18 * (p.tint ?? 0) : 0.32 + 0.3 * (p.tint ?? 0)) : 1);
        context.drawImage(sprite(p), position.x - size / 2, position.y - size / 2, size, size);
      };
      particles.forEach((p) => paint(p, time * 0.014));
      stars.forEach((p) => paint(p, 0));
      context.globalAlpha = 1;
    },
    destroy() {
      sprites.clear();
    }
  };
}

export function createGalaxyPainter(canvas, onRestored) {
  const particles = createGalaxyParticles();
  let painter;
  try {
    painter = webglPainter(canvas, particles, onRestored);
    // eslint-disable-next-line no-restricted-syntax -- 设备无 WebGL 或上下文创建失败时构造会抛出，必须换 canvas 继续渲染
  } catch {
    // A failed GL initialization must not prevent the rest of the workbench
    // from loading. A canvas cannot switch context types once GL owns it.
    const replacement = canvas.cloneNode(false);
    canvas.replaceWith(replacement);
    canvas = replacement;
  }
  painter ||= canvasPainter(canvas, particles);
  return { ...painter, canvas, particleCount: particles.length };
}
