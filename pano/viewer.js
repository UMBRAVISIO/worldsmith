/* WORLDSMITH pano viewer — self-hosted 360° equirectangular panorama viewer.
 * Vanilla WebGL 1.0, zero dependencies, no build step.
 * Ray-casts the equirect pano per pixel (full-screen triangle); drag/touch to look, wheel/pinch to zoom (FOV).
 * API: PanoViewer.mount(container, { src, autoRotate, startLat, startLon, startFov, onError })
 *      -> controller { destroy(), lookAt(lon, lat, fov), setAutoRotate(bool), getFov() }
 */
(function () {
  'use strict';

  var DEG = Math.PI / 180;

  // Full-screen triangle; the fragment shader ray-casts each pixel from the
  // camera basis (lon/lat/fov) straight into equirect UVs.
  //
  // Why not a textured sphere: the previous build rotated the sphere (uRot)
  // and then derived the texture lookup from the ROTATED position — the
  // rotation cancelled out, so lon never changed the image (lon 180 and 270
  // rendered byte-identical frames). Ray-casting has no such trap, no
  // tessellation error, and matches Viewer2D's convention exactly:
  //   f = [cos(lon)cos(lat), sin(lat), sin(lon)cos(lat)]
  //   screen-center u = 0.5 + lon/360, v = 0.5 - lat/180.
  var VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vNdc;',
    'void main() {',
    '  vNdc = aPos;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec2 vNdc;',
    'uniform sampler2D uTex;',
    'uniform vec3 uF;',   // camera forward
    'uniform vec3 uR;',   // camera right
    'uniform vec3 uU;',   // camera up
    'uniform vec2 uTan;', // tan(hfov/2), tan(vfov/2)
    'void main() {',
    '  vec3 d = normalize(uF + vNdc.x * uTan.x * uR + vNdc.y * uTan.y * uU);',
    '  float lon = atan(d.z, d.x);',       // -PI..PI
    '  float lat = asin(clamp(d.y, -1.0, 1.0));',
    '  float u = lon / 6.28318531 + 0.5;',
    '  float v = 0.5 - lat / 3.14159265;',
    '  gl_FragColor = vec4(texture2D(uTex, vec2(u, v)).rgb, 1.0);',
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

  // Camera basis for azimuth lon / elevation lat (degrees).
  function cameraBasis(lonDeg, latDeg) {
    var l = lonDeg * DEG, p = latDeg * DEG;
    var cl = Math.cos(l), sl = Math.sin(l), cp = Math.cos(p), sp = Math.sin(p);
    return {
      f: [cl * cp, sp, sl * cp],
      r: [-sl, 0, cl],
      u: [-cl * sp, cp, -sl * sp]   // cross(r, f)
    };
  }

  function PanoViewer(container, opts) {
    opts = opts || {};
    this.container = container;
    this.src = opts.src;
    this.lat = opts.startLat != null ? opts.startLat : 0;   // elevation deg
    this.lon = opts.startLon != null ? opts.startLon : 180; // azimuth deg
    this.fov = opts.startFov != null ? opts.startFov : 78;  // vertical FOV deg
    this.fovMin = 45;  // vertical FOV floor: wide beyond ~100° horizontal starts
                       // stretching the pano past its own latitude extent
    this.fovMax = 100;
    this.autoRotate = !!opts.autoRotate;
    this.rotateSpeed = opts.rotateSpeed != null ? opts.rotateSpeed : 12; // deg/SECOND (time-based, FPS-independent)
    // Internal render resolution multiplier. 0.5 exists ONLY for software-GL machines
    // (no GPU drivers); on real GPUs it just throws away half the pixels.
    this.renderScale = opts.renderScale != null ? opts.renderScale : (function () {
      try {
        var probe = document.createElement('canvas').getContext('webgl');
        var dbg = probe && probe.getExtension('WEBGL_debug_renderer_info');
        var r = dbg ? probe.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
        if (probe && probe.getExtension('WEBGL_lose_context')) probe.getExtension('WEBGL_lose_context').loseContext();
        return /swiftshader|softpipe|llvmpipe/i.test(r) ? 0.5 : 1;
      } catch (e) { return 1; }
    })();
    this.onDestroy = opts.onDestroy || null;
    this.onError = opts.onError || null;
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

    // one oversized triangle covering the viewport
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vbo = vbo;
    this.aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    this.loc = {
      f: gl.getUniformLocation(prog, 'uF'),
      r: gl.getUniformLocation(prog, 'uR'),
      u: gl.getUniformLocation(prog, 'uU'),
      tan: gl.getUniformLocation(prog, 'uTan'),
      tex: gl.getUniformLocation(prog, 'uTex')
    };
    gl.uniform1i(this.loc.tex, 0);

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

    // Re-assert all state every draw (cheap; guards against any context state
    // drift) and feed the CURRENT lon/lat/fov into the shader.
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    var aspect = this.canvas.width / Math.max(1, this.canvas.height);
    var ty = Math.tan(this.fov * DEG / 2);
    var cb = cameraBasis(this.lon, this.lat);
    gl.uniform3fv(this.loc.f, cb.f);
    gl.uniform3fv(this.loc.r, cb.r);
    gl.uniform3fv(this.loc.u, cb.u);
    gl.uniform2f(this.loc.tan, ty * aspect, ty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
      // No mipmaps: the atan() wrap at lon=±180 would make mip selection jump
      // to the smallest level along the seam and draw a visible line.
      self._texOk = true;
      self._dirty = true;
      if (self.onLoad) self.onLoad();
    };
    img.onerror = function () {
      if (self.onError) self.onError(new Error('Failed to load panorama: ' + src));
    };
    img.src = src;
  };

  // Behavioural sanity check (used by world.html before trusting WebGL):
  // draw at two azimuths 90° apart and read back a row of pixels. Passes only
  // if the draw produced non-black output AND the view actually moved. Must
  // be called after the texture has loaded.
  PanoViewer.prototype.selfTest = function () {
    var gl = this.gl;
    if (!gl || !this._texOk || gl.isContextLost()) return false;
    var w = this.canvas.width, h = this.canvas.height, y = Math.floor(h / 2);
    var lon0 = this.lon;
    function row(self, lon) {
      self.lon = lon;
      self._draw();
      var px = new Uint8Array(w * 4);
      gl.readPixels(0, y, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    }
    try {
      var a = row(this, lon0), b = row(this, lon0 + 90);
    } catch (e) { this.lon = lon0; return false; }
    this.lon = lon0;
    this._draw();
    if (gl.getError() !== gl.NO_ERROR) return false;
    var diff = 0, lit = 0;
    for (var i = 0; i < a.length; i += 4) {
      diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      lit += a[i] + a[i + 1] + a[i + 2];
    }
    return lit > w * 6 && diff > w * 3; // avg >2/channel lit, >1/channel moved
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
