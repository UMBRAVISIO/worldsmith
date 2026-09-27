/* WORLDSMITH atmosphere overlay — fog bands, candle glow, breathing vignette.
 *
 * A single 2D canvas layered ABOVE the pano canvas and BELOW the UI
 * (pointer-events: none). It never touches the viewer render paths: it only
 * reads the camera pose through CinemaCam and projects world anchors into
 * screen space, so fog and candle light stay pinned to the scene while the
 * user (or the tour) turns.
 *
 * Perf (4GB / SwiftShader dev machine):
 *  - renders at `scale` of CSS size (default 0.5; fog is soft, CSS upscales)
 *  - ~15 fps setTimeout loop (same cadence as the viewers), paused when hidden
 *  - every sprite (fog tiles, glow, vignette) is pre-rendered once; a frame is
 *    ~10-20 drawImage calls and zero allocations
 *
 * cfg (manifest "fx"):
 *  { scale, fps, vignette: 0..1,
 *    fog: [ { lat, height, alpha, speed, parallax, tile, tint:[r,g,b], seed } ],
 *    candles: { color:[r,g,b], radius (deg), intensity, points:[[lon,lat],...], pool:[lon,lat,radiusDeg] } }
 */
(function () {
  'use strict';

  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function CinemaFX(host, cam, cfg) {
    this.host = host;
    this.cam = cam;
    this.cfg = cfg || {};
    this.scale = this.cfg.scale || 0.5;
    this.frameMs = 1000 / (this.cfg.fps || 15);
    this.failed = false;
    this.frames = 0;
    this._t0 = performance.now();
    this._pt = { x: 0, y: 0, ppd: 0, vis: false };
    this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var c = document.createElement('canvas');
    c.className = 'cinema-fx';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:12;';
    host.appendChild(c);
    this.canvas = c;
    try {
      this.ctx = c.getContext('2d');
      if (!this.ctx) throw new Error('2d context unavailable');
      this._buildSprites();
    } catch (e) {
      if (c.parentNode) c.parentNode.removeChild(c);   // leave no dead layer behind
      throw e;
    }
    var self = this;
    this._onResize = function () { self._resize(); };
    window.addEventListener('resize', this._onResize);
    this._resize();
    this._loop();
  }

  CinemaFX.prototype._fail = function (e) {
    this.failed = true;
    clearTimeout(this._timer);
    if (window.console && console.warn) console.warn('[fx] disabled:', e && e.message || e);
    try { this.canvas.style.display = 'none'; } catch (x) {}
    if (this.onFail) this.onFail(e);
  };

  CinemaFX.prototype._resize = function () {
    var w = Math.max(1, Math.round(this.host.clientWidth * this.scale));
    var h = Math.max(1, Math.round(this.host.clientHeight * this.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this._buildVignette();
    }
  };

  // Horizontally seamless fog tile: soft blobs, wrapped at the tile edges.
  CinemaFX.prototype._fogTile = function (f) {
    var W = 512, H = 128;
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d'), r = mulberry(f.seed || 7);
    var tint = f.tint || [150, 144, 132];
    var col = 'rgba(' + tint[0] + ',' + tint[1] + ',' + tint[2] + ',';
    for (var i = 0; i < 46; i++) {
      var x = r() * W, y = H * (0.3 + 0.4 * r()), rx = 30 + r() * 90, a = 0.08 + r() * 0.16;
      for (var k = -1; k <= 1; k++) {
        g.save();
        g.translate(x + k * W, y);
        g.scale(1, 0.32 + r() * 0.12);
        var gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
        gr.addColorStop(0, col + a + ')');
        gr.addColorStop(0.55, col + (a * 0.5) + ')');
        gr.addColorStop(1, col + '0)');
        g.fillStyle = gr;
        g.fillRect(-rx, -rx, rx * 2, rx * 2);
        g.restore();
      }
    }
    // feather the band top/bottom
    g.globalCompositeOperation = 'destination-in';
    var fe = g.createLinearGradient(0, 0, 0, H);
    fe.addColorStop(0, 'rgba(0,0,0,0)'); fe.addColorStop(0.28, 'rgba(0,0,0,1)');
    fe.addColorStop(0.72, 'rgba(0,0,0,1)'); fe.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fe; g.fillRect(0, 0, W, H);
    return c;
  };

  CinemaFX.prototype._buildSprites = function () {
    var cfg = this.cfg;
    this.fog = [];
    var fogs = cfg.fog || [];
    for (var i = 0; i < fogs.length; i++) {
      var f = fogs[i];
      this.fog.push({
        img: this._fogTile(f), lat: f.lat || 0, height: f.height || 20, alpha: f.alpha != null ? f.alpha : 0.5,
        speed: f.speed || 0.6, parallax: f.parallax || 1.1, tile: f.tile || 120, phase: (f.seed || i) * 37
      });
    }
    // candle glow sprite (warm, additive)
    var cc = cfg.candles;
    if (cc) {
      var col = cc.color || [255, 150, 60];
      var s = document.createElement('canvas'); s.width = s.height = 128;
      var g = s.getContext('2d');
      var gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      var c0 = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',';
      gr.addColorStop(0, c0 + '0.9)'); gr.addColorStop(0.18, c0 + '0.45)');
      gr.addColorStop(0.5, c0 + '0.12)'); gr.addColorStop(1, c0 + '0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      this.glow = s;
      this.candles = cc.points || [];
      this.flick = [];
      for (var j = 0; j < this.candles.length; j++) {
        this.flick.push({ a: 5 + Math.random() * 4, b: 11 + Math.random() * 7, c: 2 + Math.random() * 2, p: Math.random() * 6.28, n: 1 });
      }
    }
  };

  CinemaFX.prototype._buildVignette = function () {
    var amt = this.cfg.vignette != null ? this.cfg.vignette : 0.5;
    var W = this.canvas.width, H = this.canvas.height;
    var v = this._vig || document.createElement('canvas');
    v.width = W; v.height = H;
    var g = v.getContext('2d');
    g.clearRect(0, 0, W, H);
    var r = Math.hypot(W, H) / 2;
    var gr = g.createRadialGradient(W / 2, H / 2, r * 0.42, W / 2, H / 2, r);
    gr.addColorStop(0, 'rgba(8,7,6,0)');
    gr.addColorStop(0.6, 'rgba(8,7,6,' + (amt * 0.45) + ')');
    gr.addColorStop(1, 'rgba(6,5,4,' + amt + ')');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    var lg = g.createLinearGradient(0, 0, 0, H);
    lg.addColorStop(0, 'rgba(20,17,14,' + (amt * 0.55) + ')'); lg.addColorStop(0.16, 'rgba(20,17,14,0)');
    lg.addColorStop(0.8, 'rgba(10,9,8,0)'); lg.addColorStop(1, 'rgba(10,9,8,' + (amt * 0.7) + ')');
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
    this._vig = v;
  };

  CinemaFX.prototype._loop = function () {
    var self = this;
    function frame() {
      self._timer = null;
      if (self.failed || self.stopped) return;
      if (!document.hidden) {
        try { self.draw(); } catch (e) { self._fail(e); return; }
      }
      self._timer = setTimeout(frame, self.frameMs);
    }
    this._timer = setTimeout(frame, 0);
  };

  CinemaFX.prototype.draw = function () {
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, sc = this.scale;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    if (!this.cam.ready()) return;
    var s = this.cam.read();
    if (!s) return;
    var t = (performance.now() - this._t0) / 1000;
    if (this.reduced) t *= 0.15;
    var pt = this._pt, i, k;

    // --- fog bands, anchored to world lat, parallax-drifting with lon ---
    for (i = 0; i < this.fog.length; i++) {
      var f = this.fog[i];
      this.cam.project(s.lon, f.lat, pt);
      if (!pt.vis) continue;
      var ppd = pt.ppd * sc;
      var bandH = f.height * ppd, cy = pt.y * sc;
      if (cy + bandH < 0 || cy - bandH > H) continue;
      var tw = f.tile * ppd * f.parallax;
      if (tw < 8) continue;
      // turning right slides the band left; parallax > 1 = nearer, moves faster
      var off = ((f.speed * t + f.phase - s.lon) * ppd * f.parallax) % tw;
      if (off > 0) off -= tw;
      // slow breathing of density
      ctx.globalAlpha = f.alpha * (0.82 + 0.18 * Math.sin(t * 0.21 + f.phase));
      for (var x = off; x < W; x += tw) ctx.drawImage(f.img, x, cy - bandH / 2, tw + 1, bandH);
    }

    // --- candle glow, additive, independent flicker per votive ---
    if (this.glow && this.candles.length) {
      var cc = this.cfg.candles, inten = cc.intensity != null ? cc.intensity : 0.7;
      ctx.globalCompositeOperation = 'lighter';
      if (cc.pool) {
        this.cam.project(cc.pool[0], cc.pool[1], pt);
        if (pt.vis) {
          var pr = cc.pool[2] * pt.ppd * sc;
          ctx.globalAlpha = inten * 0.35 * (0.85 + 0.1 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 17.9));
          ctx.drawImage(this.glow, pt.x * sc - pr, pt.y * sc - pr * 0.55, pr * 2, pr * 1.1);
        }
      }
      var rad = cc.radius || 2.2;
      for (k = 0; k < this.candles.length; k++) {
        var p = this.candles[k];
        this.cam.project(p[0], p[1], pt);
        if (!pt.vis) continue;
        var px = pt.x * sc, py = pt.y * sc;
        if (px < -60 || px > W + 60 || py < -60 || py > H + 60) continue;
        var fl = this.flick[k];
        // occasional gutter dip (random walk, no allocation)
        fl.n += (Math.random() < 0.02 ? -0.5 : 0) + (1 - fl.n) * 0.12;
        var a = 0.72 + 0.14 * Math.sin(t * fl.a + fl.p) + 0.08 * Math.sin(t * fl.b + fl.p * 2) + 0.06 * Math.sin(t * fl.c);
        a *= fl.n;
        var r2 = rad * pt.ppd * sc * (0.92 + 0.08 * a);
        ctx.globalAlpha = Math.max(0, Math.min(1, inten * a));
        ctx.drawImage(this.glow, px - r2, py - r2 * 1.25, r2 * 2, r2 * 2.2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // --- vignette (pre-rendered), faint breathing ---
    if (this._vig) {
      ctx.globalAlpha = 0.9 + 0.1 * Math.sin(t * 0.35);
      ctx.drawImage(this._vig, 0, 0);
    }
    ctx.globalAlpha = 1;
    this.frames++;
  };

  CinemaFX.prototype.destroy = function () {
    this.stopped = true;
    clearTimeout(this._timer);
    window.removeEventListener('resize', this._onResize);
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };

  window.CinemaFX = CinemaFX;
})();
