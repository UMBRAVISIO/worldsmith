/* WORLDSMITH camera adapter — one camera API over both pano viewers.
 *
 * PanoViewer (WebGL) keeps { lon, lat, fov } with fov = VERTICAL degrees.
 * Viewer2D keeps { lon, lat, _zoomK } where horizontal fov = 90° / zoomK.
 * The adapter speaks lon/lat/fov (vertical, WebGL convention) and maps fov
 * onto Viewer2D's zoom so that fov 78 (the site default) == zoomK 1 (the 2D
 * default). It never touches either viewer's render path: it only reads and
 * writes the public pose fields, exactly like drag/keyboard input does.
 *
 * Also provides:
 *   project(lon, lat, out)  world direction -> CSS px on the mount (for overlays)
 *   onUserInput(cb)         fires on real drag / wheel / pinch / look-keys
 * Zero allocations per call: read()/project() fill caller-owned objects.
 */
(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var BASE_T = Math.tan(39 * DEG); // tan(78°/2): 2D zoomK 1 <=> vertical fov 78

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function wrap180(d) { d = (d + 180) % 360; if (d < 0) d += 360; return d - 180; }

  function CinemaCam(getView, mountEl) {
    this._get = getView;          // function returning the CURRENT viewer (it can be swapped GL -> 2D)
    this.mount = mountEl;
    this.state = { lon: 0, lat: 0, fov: 78, kind: '' };
    this.W = mountEl.clientWidth || 1;
    this.H = mountEl.clientHeight || 1;
    var self = this;
    this._onResize = function () {
      self.W = self.mount.clientWidth || 1;
      self.H = self.mount.clientHeight || 1;
    };
    window.addEventListener('resize', this._onResize);
  }

  CinemaCam.wrap180 = wrap180;

  CinemaCam.prototype.view = function () { return this._get(); };

  CinemaCam.prototype.is2D = function (v) {
    v = v || this._get();
    return !!v && typeof v._zoomK === 'number';
  };

  CinemaCam.prototype.ready = function () {
    var v = this._get();
    return !!v && !!v._texOk;
  };

  // Current pose, written into this.state (shared object — copy if you keep it).
  CinemaCam.prototype.read = function () {
    var v = this._get(), s = this.state;
    if (!v) return null;
    s.lon = v.lon; s.lat = v.lat;
    if (this.is2D(v)) { s.kind = '2d'; s.fov = 2 * Math.atan(BASE_T / v._zoomK) / DEG; }
    else { s.kind = 'gl'; s.fov = v.fov; }
    return s;
  };

  CinemaCam.prototype.write = function (lon, lat, fov) {
    var v = this._get();
    if (!v) return;
    if (this.is2D(v)) {
      v.lon = lon;
      v.lat = clamp(lat, -60, 60);
      if (fov != null) v._zoomK = clamp(BASE_T / Math.tan(fov * DEG / 2), 0.75, 3);
    } else if (v.lookAt) {
      v.lookAt(lon, lat, fov);
    }
  };

  CinemaCam.prototype.setAutoRotate = function (on) {
    var v = this._get();
    if (v && v.setAutoRotate) v.setAutoRotate(on);
  };

  /* World direction (lon/lat deg, same convention as both viewers) to CSS
   * pixels on the mount. out gets { x, y, ppd (px per degree near centre), vis }.
   * WebGL: exact rectilinear projection through the camera basis.
   * 2D: Viewer2D's own cylinder mapping (atan columns, linear latitude). */
  CinemaCam.prototype.project = function (lon, lat, out) {
    var v = this._get(), W = this.W, H = this.H;
    out.vis = false;
    if (!v) return out;
    if (this.is2D(v)) {
      var hfov = (Math.PI / 2) / v._zoomK;
      var R = (W / 2) / Math.tan(hfov / 2);
      var a = wrap180(lon - v.lon) * DEG;
      if (a > 1.45 || a < -1.45) return out;
      out.x = W / 2 + R * Math.tan(a);
      out.y = H / 2 - (lat - v.lat) * DEG * R;
      out.ppd = R * DEG;
      out.vis = true;
      return out;
    }
    var l = v.lon * DEG, p = v.lat * DEG;
    var cl = Math.cos(l), sl = Math.sin(l), cp = Math.cos(p), sp = Math.sin(p);
    var L = lon * DEG, P = lat * DEG, cP = Math.cos(P);
    var dx = Math.cos(L) * cP, dy = Math.sin(P), dz = Math.sin(L) * cP;
    var z = dx * cl * cp + dy * sp + dz * sl * cp;          // d . f
    if (z < 0.08) return out;
    var xr = -dx * sl + dz * cl;                            // d . r
    var yu = -dx * cl * sp + dy * cp - dz * sl * sp;        // d . u
    var ty = Math.tan(v.fov * DEG / 2), tx = ty * W / H;
    out.x = (xr / z / tx + 1) * W / 2;
    out.y = (1 - yu / z / ty) * H / 2;
    out.ppd = (H / 2) / ty * DEG;
    out.vis = true;
    return out;
  };

  /* Real user camera input -> cb(kind). Listens on the mount in capture phase
   * (never stops propagation), so it sees both viewers and survives a GL->2D
   * swap. A plain click (no movement) does not count as input. */
  CinemaCam.prototype.onUserInput = function (cb) {
    var el = this.mount, down = null;
    el.addEventListener('pointerdown', function (e) {
      down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    }, true);
    el.addEventListener('pointermove', function (e) {
      if (!down || !e.buttons) return;
      if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 6) { down = null; cb('drag'); }
    }, true);
    var up = function () { down = null; };
    el.addEventListener('pointerup', up, true);
    el.addEventListener('pointercancel', up, true);
    el.addEventListener('wheel', function () { cb('zoom'); }, { capture: true, passive: true });
    el.addEventListener('touchstart', function (e) { if (e.touches && e.touches.length > 1) cb('pinch'); }, { capture: true, passive: true });
    document.addEventListener('keydown', function (e) {
      var t = document.activeElement;
      // mirror the viewers: they ignore keys while a button/input has focus
      if (t && t !== el && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return;
      if (/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|\+|=|-|_)$/.test(e.key)) cb('key');
    }, true);
  };

  window.CinemaCam = CinemaCam;
})();
