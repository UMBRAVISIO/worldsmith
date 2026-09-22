/* WORLDSMITH pano viewer — self-hosted 360° equirectangular panorama viewer.
 * Vanilla WebGL 1.0, zero dependencies, no build step.
 * Renders the pano onto the inside of a sphere; drag/touch to look, wheel/pinch to zoom (FOV).
 * API: PanoViewer.mount(container, { src, autoRotate, startLat, startLon, startFov, onError })
 *      -> controller { destroy(), lookAt(lon, lat, fov), setAutoRotate(bool), getFov() }
 */
(function () {
  'use strict';

  var DEG = Math.PI / 180;

  var VERT = [
    'attribute vec3 aPos;',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'uniform mat4 uRot; // yaw/pitch spin of the sphere itself (reversed look)',
    'varying vec3 vDir;',
    'void main() {',
    '  vec4 world = uRot * vec4(aPos, 1.0);',
    '  gl_Position = uProj * uView * world;',
    '  vDir = normalize(world.xyz);',
    '}'
  ].join('\n');

  // Equirectangular mapping with the sphere seam behind the camera at spawn
  // (we pre-rotate uRot so the captured horizon faces the initial view).
  var FRAG = [
    'precision mediump float;',
    'varying vec3 vDir;',
    'uniform sampler2D uTex;',
    'void main() {',
    '  vec3 d = normalize(vDir);',
    '  float lon = atan(d.z, d.x);',       // -PI..PI
    '  float lat = asin(clamp(d.y, -1.0, 1.0));',
    '  float u = lon / (2.0 * 3.14159265) + 0.5;',
    '  float v = 0.5 - lat / 3.14159265;',
    // cross-fade across the wrap seam to hide the bilinear join line
    '  float w = min(smoothstep(0.0, 0.004, u), 1.0 - smoothstep(0.996, 1.0, u));',
    '  vec3 a = texture2D(uTex, vec2(u, v)).rgb;',
    '  vec3 b = texture2D(uTex, vec2(fract(u + 1.0), v)).rgb;',
    '  gl_FragColor = vec4(mix(b, a, w), 1.0);',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function mat4Mul(a, b) {
    var out = new Float32Array(16);
    for (var c = 0; c < 4; c++)
      for (var r = 0; r < 4; r++) {
        var s = 0;
        for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = s;
      }
    return out;
  }

  function perspective(fovyDeg, aspect, near, far) {
    var f = 1 / Math.tan(fovyDeg * DEG / 2);
    var nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  // Camera at origin, looking along -Z, with roll/pitch applied as a view rotation.
  function viewMatrix(pitchDeg, rollDeg) {
    var p = pitchDeg * DEG, r = rollDeg * DEG;
    var cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
    // rotate world by pitch then roll (inverse of camera rotation)
    return new Float32Array([
      cr, 0, -sr, 0,
      sp * sr, cp, sp * cr, 0,
      cp * sr, -sp, cp * cr, 0,
      0, 0, 0, 1
    ]);
  }

  // Rotation of the sphere: inverse of the camera's yaw/pitch look direction.
  // lon = azimuth (deg, 0 = -Z), lat = elevation (deg).
  function sphereRot(lonDeg, latDeg) {
    var y = -lonDeg * DEG;   // yaw about Y
    var x = latDeg * DEG;    // pitch about X (applied after yaw)
    var cy = Math.cos(y), sy = Math.sin(y);
    var cx = Math.cos(x), sx = Math.sin(x);
    // R = Ry(y) * Rx(x)
    return new Float32Array([
      cy, sx * sy, -cx * sy, 0,
      0, cx, sx, 0,
      sy, -sx * cy, cx * cy, 0,
      0, 0, 0, 1
    ]);
  }

  function PanoViewer(container, opts) {
    opts = opts || {};
    this.container = container;
    this.src = opts.src;
    this.lat = opts.startLat != null ? opts.startLat : 0;   // elevation deg
    this.lon = opts.startLon != null ? opts.startLon : 180; // azimuth deg
    this.fov = opts.startFov != null ? opts.startFov : 78;  // vertical FOV deg
    this.fovMin = 35;
    this.fovMax = 100;
    this.autoRotate = !!opts.autoRotate;
    this.rotateSpeed = opts.rotateSpeed != null ? opts.rotateSpeed : 12; // deg/SECOND (time-based, FPS-independent)
    this.renderScale = opts.renderScale != null ? opts.renderScale : 0.5; // internal res multiplier
    this.onDestroy = opts.onDestroy || null;
    this._raf = null;
    this._texOk = false;
    this._dirty = true;   // draw-on-demand: only redraw when state changed
    this._build();
    this._bind();
    this._loop();
    if (this.src) this.load(this.src);
  }

  PanoViewer.prototype._build = function () {
    var c = document.createElement('canvas');
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.display = 'block';
    c.style.touchAction = 'none';
    this.container.appendChild(c);
    this.canvas = c;

    var glOpts = { antialias: true, alpha: false, powerPreference: 'low-power' };
    var gl = c.getContext('webgl', glOpts) || c.getContext('experimental-webgl', glOpts);
    if (!gl) throw new Error('WebGL unavailable in this browser');
    this.gl = gl;

    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    this.prog = prog;

    // sphere: 48x32 segments, radius 50, camera at center
    var seg = [48, 32], R = 50;
    var verts = [], idx = [];
    for (var y = 0; y <= seg[1]; y++) {
      var v = y / seg[1], phi = v * Math.PI;
      for (var x = 0; x <= seg[0]; x++) {
        var u = x / seg[0], theta = u * 2 * Math.PI;
        verts.push(-R * Math.sin(phi) * Math.cos(theta),
                    R * Math.cos(phi),
                    R * Math.sin(phi) * Math.sin(theta));
      }
    }
    for (y = 0; y < seg[1]; y++)
      for (x = 0; x < seg[0]; x++) {
        var a = y * (seg[0] + 1) + x, b = a + seg[0] + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    this._nIdx = idx.length;
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    var ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

    var loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    this.loc = {
      proj: gl.getUniformLocation(prog, 'uProj'),
      view: gl.getUniformLocation(prog, 'uView'),
      rot: gl.getUniformLocation(prog, 'uRot')
    };
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([10, 9, 8]));
  };

  PanoViewer.prototype._bind = function () {
    var self = this, el = this.canvas;
    var pointers = new Map();
    var lastPinch = 0;

    function pos(e) { return { x: e.clientX, y: e.clientY }; }

    el.addEventListener('pointerdown', function (e) {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, pos(e));
      if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        lastPinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      }
    });
    el.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      var prev = pointers.get(e.pointerId);
      var cur = pos(e);
      pointers.set(e.pointerId, cur);
      if (pointers.size === 1) {
        // ~1:1 feel: a full-viewport drag spans roughly the current FOV
        var k = self.fov / el.clientHeight;
        self.lon -= (cur.x - prev.x) * k * 1.5;
        self.lat += (cur.y - prev.y) * k * 1.5;
        self.lat = Math.max(-85, Math.min(85, self.lat));
        self._dirty = true;
        if (self.onUserMove) self.onUserMove();
      } else if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (lastPinch > 0) { self._zoom((lastPinch - d) * 0.12); self._dirty = true; }
        lastPinch = d;
      }
    });
    function release(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastPinch = 0;
    }
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);

    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      self._zoom(e.deltaY * 0.03);
      self._dirty = true;
    }, { passive: false });

    // keyboard: arrows to look, +/- (and shift) to zoom — on the canvas so it
    // works when focused, and on the document as fallback when nothing else
    // has focus. Tab to the canvas or click once to focus.
    el.tabIndex = 0;
    el.style.outline = 'none';
    function keyTurn(e) {
      var step = e.shiftKey ? 10 : 4; // deg per press
      switch (e.key) {
        case 'ArrowLeft':  self.lon -= step; break;
        case 'ArrowRight': self.lon += step; break;
        case 'ArrowUp':    self.lat = Math.min(85, self.lat + step); break;
        case 'ArrowDown':  self.lat = Math.max(-85, self.lat - step); break;
        case '+': case '=': self._zoom(-3); break;
        case '-': case '_': self._zoom(3); break;
        default: return false;
      }
      e.preventDefault();
      self._dirty = true;
      if (self.onUserMove) self.onUserMove();
      return true;
    }
    el.addEventListener('keydown', keyTurn);
    document.addEventListener('keydown', function (e) {
      // skip when the canvas handler already handled it (focus) or an input has focus
      if (e.target === el || e.defaultPrevented) return;
      var t = document.activeElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return;
      keyTurn(e);
    });

    this._onResize = function () { self._dirty = true; self._resize(); };
    window.addEventListener('resize', this._onResize);
    this._pointers = pointers;
    this._resize();
  };

  PanoViewer.prototype._zoom = function (dFov) {
    this.fov = Math.max(this.fovMin, Math.min(this.fovMax, this.fov + dFov));
  };

  PanoViewer.prototype._resize = function () {
    var c = this.canvas;
    var w = this.container.clientWidth, h = this.container.clientHeight;
    // Software-rendered machines (no GPU drivers) can't redraw fullscreen WebGL
    // at interactive rates — render internally at reduced resolution and let CSS
    // upscale. Pano content is soft/foggy so the quality loss is invisible.
    var dpr = Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
    w = Math.max(1, Math.round(w * dpr));
    h = Math.max(1, Math.round(h * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (this.gl) this.gl.viewport(0, 0, w, h);
  };

  PanoViewer.prototype._loop = function () {
    var self = this;
    var lastT = 0; // ms timestamp of last frame, for time-based motion
    function frame() {
      // setTimeout callbacks receive NO timestamp — always use performance.now().
      var t = performance.now();
      var dt = lastT ? Math.min(100, t - lastT) : 16; // ms, clamped
      lastT = t;
      if (self.autoRotate && self._texOk && self._pointers.size === 0) {
        self.lon -= self.rotateSpeed * (dt / 1000);
        self._dirty = true;
      }
      if (self._dirty && self._texOk) {
        self._dirty = false;
      }
      // Always draw every tick: simple, and the compositor keeps up on fresh
      // frames. Time-based drift keeps motion FPS-independent.
      self._draw();
      self._raf = setTimeout(frame, 66); // ~15fps target
    }
    this._raf = requestAnimationFrame(frame);
  };

  PanoViewer.prototype._draw = function () {
    var gl = this.gl;
    if (!gl) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.04, 0.035, 0.03, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this._texOk) return;

    var aspect = this.canvas.width / Math.max(1, this.canvas.height);
    gl.uniformMatrix4fv(this.loc.proj, false, perspective(this.fov, aspect, 0.1, 100));
    gl.uniformMatrix4fv(this.loc.view, false, viewMatrix(0, 0));
    gl.uniformMatrix4fv(this.loc.rot, false, sphereRot(this.lon, this.lat));
    gl.drawElements(gl.TRIANGLES, this._nIdx, gl.UNSIGNED_SHORT, 0);
  };

  PanoViewer.prototype.load = function (src) {
    var self = this, gl = this.gl;
    this._texOk = false;
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      gl.bindTexture(gl.TEXTURE_2D, self.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      self._texOk = true;
      self._dirty = true;
      if (self.onLoad) self.onLoad();
    };
    img.onerror = function () {
      if (self.onError) self.onError(new Error('Failed to load panorama: ' + src));
    };
    img.src = src;
  };

  PanoViewer.prototype.lookAt = function (lon, lat, fov) {
    if (lon != null) this.lon = lon;
    if (lat != null) this.lat = Math.max(-85, Math.min(85, lat));
    if (fov != null) this.fov = Math.max(this.fovMin, Math.min(this.fovMax, fov));
    this._dirty = true;
  };

  PanoViewer.prototype.setAutoRotate = function (on) {
    this.autoRotate = !!on;
  };

  PanoViewer.prototype.destroy = function () {
    clearTimeout(this._raf);
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    if (this.onDestroy) this.onDestroy();
  };

  window.PanoViewer = {
    mount: function (container, opts) { var inst = new PanoViewer(container, opts); window.__lastViewer = inst; return inst; }
  };
})();
