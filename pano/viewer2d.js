/* WORLDSMITH 2D pano viewer — software-rendering-safe.
 * Renders the equirectangular pano as a cylindrical projection using 2D canvas
 * slice drawing. No WebGL: immune to SwiftShader compositor quirks on machines
 * without GPU drivers. Interface-compatible with viewer.js.
 *
 * Cylinder math: the camera sits at the center of a cylinder of radius R =
 * (canvasWidth / 2) / tan(hfov/2). Each screen column x maps to an angle
 * a = atan((x - cx) / R); the texture sample longitude is lon + a. We draw in
 * SLICES vertical strips, computing source-x per strip — cheap and smooth.
 * Vertical: equirect rows map linearly; we scale the visible lat band to fill
 * the canvas height (simple look-up/look-down without full 3D).
 */
(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var SLICES = 64;

  function Viewer2D(container, opts) {
    opts = opts || {};
    this.container = container;
    this.src = opts.src;
    this.lon = opts.startLon != null ? opts.startLon : 180;
    this.lat = opts.startLat != null ? opts.startLat : 0;
    this.autoRotate = !!opts.autoRotate;
    this.rotateSpeed = opts.rotateSpeed != null ? opts.rotateSpeed : 6; // deg/s
    this.onUserMove = opts.onUserMove || null;
    this.onDestroy = opts.onDestroy || null;
    this.onError = opts.onError || null;
    this._img = null;
    this._texOk = false;
    this._raf = null;
    this._pointers = new Map();
    this._zoomK = 1; // 1 = default horizontal FOV (90°); 2 = 45°; 0.5 = 180°
    this._build();
    this._bind();
    this._loop();
    if (this.src) this.load(this.src);
  }

  Viewer2D.prototype._build = function () {
    var c = document.createElement('canvas');
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.display = 'block';
    c.style.touchAction = 'none';
    c.style.backgroundColor = '#0a0908';
    this.container.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d');
    this._onResize = this._resize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._resize();
  };

  Viewer2D.prototype._resize = function () {
    var w = this.container.clientWidth, h = this.container.clientHeight;
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  };

  Viewer2D.prototype.lookAt = function (lon, lat) {
    if (typeof lon === 'number') this.lon = lon;
    if (typeof lat === 'number') this.lat = Math.max(-60, Math.min(60, lat));
  };

  Viewer2D.prototype.setAutoRotate = function (on) {
    this.autoRotate = !!on;
  };

  Viewer2D.prototype._zoom = function (mult) {
    this._zoomK = Math.max(0.4, Math.min(3, this._zoomK * mult));
  };

  Viewer2D.prototype.load = function (src) {
    var self = this;
    this._texOk = false;
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      self._img = img;
      self._texOk = true;
      if (self.onLoad) self.onLoad();
    };
    img.onerror = function () {
      if (self.onError) self.onError(new Error('Failed to load panorama: ' + src));
    };
    img.src = src;
  };

  Viewer2D.prototype._draw = function () {
    var ctx = this.ctx;
    if (!ctx || !this._texOk) return;
    var W = this.canvas.width, H = this.canvas.height;
    var img = this._img;
    var iw = img.width, ih = img.height;

    // Horizontal FOV shrinks as zoomK grows: hfov = 90 / zoomK degrees.
    var hfov = (Math.PI / 2) / this._zoomK;
    var R = (W / 2) / Math.tan(hfov / 2); // cylinder radius in px

    // Vertical: center row of the equirect at eye level; the visible vertical
    // span scales with zoom. lat tilts the band up/down.
    var vSpan = (H / R); // radians of world latitude visible vertically (approx)
    var latRad = this.lat * DEG;
    var topLat = latRad + vSpan / 2;
    var botLat = latRad - vSpan / 2;

    ctx.fillStyle = '#0a0908';
    ctx.fillRect(0, 0, W, H);

    var cx = W / 2;
    var angAt = function (sx) { return Math.atan((sx - cx) / R); };
    var imgXForLon = function (lonRad) {
      // equirect: x = (lon + PI) / (2PI) * iw — spawn seam at image center
      return ((lonRad + Math.PI) / (2 * Math.PI)) * iw;
    };

    var lonRad = this.lon * DEG;
    for (var i = 0; i < SLICES; i++) {
      var x0 = (i * W) / SLICES;
      var x1 = ((i + 1) * W) / SLICES;
      var a0 = angAt(x0), a1 = angAt(x1);
      // sample longitude at slice center
      var slon = lonRad + (a0 + a1) / 2;
      var sxC = imgXForLon(slon);
      var halfSw = ((a1 - a0) / (2 * Math.PI)) * iw; // slice width in image px
      if (halfSw <= 0) continue;

      // vertical source band: equirect y from lat (+90 top → 0, -90 bottom → ih)
      var sy0 = ((90 - topLat * (180 / Math.PI)) / 180) * ih;
      var sy1 = ((90 - botLat * (180 / Math.PI)) / 180) * ih;
      var sh = Math.max(1, sy1 - sy0);

      // wrap: drawImage can't wrap — clamp/duplicate handled by modulo below
      var sxStart = ((sxC - halfSw) % iw + iw) % iw;
      var sw = halfSw * 2;
      if (sxStart + sw <= iw) {
        ctx.drawImage(img, sxStart, sy0, sw, sh, x0, 0, x1 - x0, H);
      } else {
        var firstPart = iw - sxStart;
        var frac = firstPart / sw;
        ctx.drawImage(img, sxStart, sy0, firstPart, sh, x0, 0, (x1 - x0) * frac, H);
        ctx.drawImage(img, 0, sy0, sw - firstPart, sh, x0 + (x1 - x0) * frac, 0, (x1 - x0) * (1 - frac), H);
      }
    }
  };

  Viewer2D.prototype._bind = function () {
    var self = this, el = this.canvas;
    var pointers = new Map();
    var lastPinch = 0;

    el.addEventListener('pointerdown', function (e) {
      el.setPointerCapture(e.pointerId);
      self._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    el.addEventListener('pointermove', function (e) {
      if (!self._pointers.has(e.pointerId)) return;
      var prev = self._pointers.get(e.pointerId);
      self._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (self._pointers.size === 1) {
        // degrees of lon per pixel — a half-viewport drag ≈ 90° at default zoom
        var k = 180 / el.clientWidth / self._zoomK;
        self.lon -= (e.clientX - prev.x) * k;
        self.lat += (e.clientY - prev.y) * k * 0.6;
        self.lat = Math.max(-60, Math.min(60, self.lat));
        if (self.onUserMove) self.onUserMove();
      } else if (self._pointers.size === 2) {
        var pts = Array.from(self._pointers.values());
        var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (lastPinch > 0) self._zoom(lastPinch / d);
        lastPinch = d;
      }
    });
    function release(e) {
      self._pointers.delete(e.pointerId);
      if (self._pointers.size < 2) lastPinch = 0;
    }
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);

    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      self._zoom(e.deltaY > 0 ? 0.9 : 1.1);
    }, { passive: false });

    el.tabIndex = 0;
    el.style.outline = 'none';
    function keyTurn(e) {
      var step = e.shiftKey ? 10 : 4;
      switch (e.key) {
        case 'ArrowLeft':  self.lon -= step; break;
        case 'ArrowRight': self.lon += step; break;
        case 'ArrowUp':    self.lat = Math.min(60, self.lat + step); break;
        case 'ArrowDown':  self.lat = Math.max(-60, self.lat - step); break;
        case '+': case '=': self._zoom(1.1); break;
        case '-': case '_': self._zoom(0.9); break;
        default: return;
      }
      e.preventDefault();
      if (self.onUserMove) self.onUserMove();
    }
    el.addEventListener('keydown', keyTurn);
    document.addEventListener('keydown', function (e) {
      if (e.target === el || e.defaultPrevented) return;
      var t = document.activeElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return;
      keyTurn(e);
    });
  };

  Viewer2D.prototype._loop = function () {
    var self = this;
    var lastT = performance.now();
    function frame() {
      var t = performance.now();
      var dt = Math.min(100, t - lastT);
      lastT = t;
      if (self.autoRotate && self._pointers.size === 0) {
        self.lon -= self.rotateSpeed * (dt / 1000);
      }
      self._draw();
      self._raf = setTimeout(frame, 66);
    }
    this._raf = requestAnimationFrame(frame);
  };

  Viewer2D.prototype.destroy = function () {
    // the loop reschedules via setTimeout after the first rAF — clear both
    if (this._raf) { clearTimeout(this._raf); cancelAnimationFrame(this._raf); }
    window.removeEventListener('resize', this._onResize);
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    if (this.onDestroy) this.onDestroy();
  };

  window.Viewer2D = Viewer2D;
})();
