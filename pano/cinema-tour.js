/* WORLDSMITH guided tour ("director mode").
 *
 * Drives the camera along a keyframed lon/lat/fov timeline synced to a
 * narration track, with a music bed and a timed bell. Works on both viewers
 * through CinemaCam. Any real user camera input cancels gracefully.
 *
 * Clock: a wall clock that is slaved to narration.currentTime while the
 * narration plays (soft correction, hard snap on >0.3 s drift) and HOLDS while
 * the narration is buffering, so the camera never runs ahead of the voice. If
 * the narration fails to load, the tour runs on the wall clock with captions.
 *
 * Motion: piecewise cubic Hermite. Keyframes flagged stop:true get zero
 * velocity (camera comes to rest); others get Catmull-Rom tangents so motion
 * flows through them. Lon is unwrapped so the camera always takes the short way.
 *
 * hooks (all optional, provided by world.html):
 *   onState(state)             'loading' | 'playing' | 'ending' | 'idle'
 *   onCaption(text|null)
 *   duckAmbience(k)            scale ambience level (1 = restore)
 *   soundscape                 CinemaAudio instance (duck / pauseEvents / bell one-shot)
 *   onFinish(reason)           'end' | 'user' | 'error'
 *   startPose()                -> { lon, lat, fov } final resting pose (startLon)
 */
(function () {
  'use strict';

  var TICK_MS = 40;
  var CANCEL_FADE_MS = 1200;

  function lerpVolume(el, to, ms, done) {
    if (!el) { if (done) done(); return null; }
    var from = el.volume, t0 = performance.now();
    var id = setInterval(function () {
      var k = Math.min(1, (performance.now() - t0) / ms);
      try { el.volume = Math.max(0, Math.min(1, from + (to - from) * k)); } catch (e) {}
      if (k >= 1) { clearInterval(id); if (done) done(); }
    }, 40);
    return id;
  }

  function CinemaTour(cfg, cam, hooks) {
    this.cfg = cfg;
    this.cam = cam;
    this.hooks = hooks || {};
    this.state = 'idle';
    this.t = 0;
    this.stats = { ticks: 0, snaps: 0, bell: null, maxDrift: 0 };
    this._timers = [];
    this._fades = [];
    this._pose = { lon: 0, lat: 0, fov: 78 };
    this._prepKeys();
    var self = this;
    cam.onUserInput(function (kind) { if (self.state === 'playing' || self.state === 'loading') self.cancel('user', kind); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && (self.state === 'playing' || self.state === 'loading')) self.cancel('user', 'escape');
    });
    // tab hidden: keep media & clock coherent (media keeps playing, tick uses media clock)
  }

  CinemaTour.prototype._prepKeys = function () {
    var ks = this.cfg.keyframes;
    var n = ks.length;
    this.K = { t: new Float64Array(n), lon: new Float64Array(n), lat: new Float64Array(n), fov: new Float64Array(n), stop: new Uint8Array(n) };
    for (var i = 0; i < n; i++) {
      this.K.t[i] = ks[i].t; this.K.lon[i] = ks[i].lon; this.K.lat[i] = ks[i].lat;
      this.K.fov[i] = ks[i].fov; this.K.stop[i] = ks[i].stop ? 1 : 0;
    }
    this.mLon = new Float64Array(n); this.mLat = new Float64Array(n); this.mFov = new Float64Array(n);
  };

  // Rebuild keyframe 0 from the live pose, final key from startPose, unwrap lon, compute tangents.
  CinemaTour.prototype._arm = function () {
    var K = this.K, n = K.t.length, s = this.cam.read();
    var ks = this.cfg.keyframes, i;
    for (i = 0; i < n; i++) { K.lon[i] = ks[i].lon; K.lat[i] = ks[i].lat; K.fov[i] = ks[i].fov; }
    if (this.hooks.startPose) {
      var sp = this.hooks.startPose();
      if (sp) { K.lon[n - 1] = sp.lon; K.lat[n - 1] = sp.lat; K.fov[n - 1] = sp.fov; }
    }
    if (s) { K.lon[0] = s.lon; K.lat[0] = s.lat; K.fov[0] = s.fov; }
    // unwrap: each key's lon is moved by 360s to be within 180 of the previous one
    for (i = 1; i < n; i++) {
      var d = CinemaCam.wrap180(K.lon[i] - K.lon[i - 1]);
      K.lon[i] = K.lon[i - 1] + d;
    }
    this._tangents(K.lon, this.mLon);
    this._tangents(K.lat, this.mLat);
    this._tangents(K.fov, this.mFov);
  };

  CinemaTour.prototype._tangents = function (p, m) {
    var K = this.K, n = p.length;
    for (var i = 0; i < n; i++) {
      if (i === 0 || i === n - 1 || K.stop[i]) { m[i] = 0; continue; }
      var slope = (p[i + 1] - p[i - 1]) / (K.t[i + 1] - K.t[i - 1]);
      // monotone guard (Fritsch-Carlson style): no overshoot at local extrema
      var a = p[i] - p[i - 1], b = p[i + 1] - p[i];
      if (a * b <= 0) { m[i] = 0; continue; }
      var lim = 3 * Math.min(Math.abs(a) / (K.t[i] - K.t[i - 1]), Math.abs(b) / (K.t[i + 1] - K.t[i]));
      m[i] = Math.max(-lim, Math.min(lim, slope));
    }
  };

  CinemaTour.prototype._sample = function (t, out) {
    var K = this.K, n = K.t.length, i = 0;
    if (t <= K.t[0]) { out.lon = K.lon[0]; out.lat = K.lat[0]; out.fov = K.fov[0]; return out; }
    if (t >= K.t[n - 1]) { out.lon = K.lon[n - 1]; out.lat = K.lat[n - 1]; out.fov = K.fov[n - 1]; return out; }
    while (i < n - 2 && t > K.t[i + 1]) i++;
    var h = K.t[i + 1] - K.t[i], u = (t - K.t[i]) / h;
    var u2 = u * u, u3 = u2 * u;
    var h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    out.lon = h00 * K.lon[i] + h10 * h * this.mLon[i] + h01 * K.lon[i + 1] + h11 * h * this.mLon[i + 1];
    out.lat = h00 * K.lat[i] + h10 * h * this.mLat[i] + h01 * K.lat[i + 1] + h11 * h * this.mLat[i + 1];
    out.fov = h00 * K.fov[i] + h10 * h * this.mFov[i] + h01 * K.fov[i + 1] + h11 * h * this.mFov[i + 1];
    return out;
  };

  CinemaTour.prototype._media = function (src, vol) {
    var a = new Audio();
    a.preload = 'auto';
    a.src = src;
    a.volume = vol;
    return a;
  };

  CinemaTour.prototype._setState = function (s) {
    this.state = s;
    if (this.hooks.onState) this.hooks.onState(s);
  };

  /* Must be called synchronously from the click handler (autoplay policy). */
  CinemaTour.prototype.start = function () {
    if (this.state !== 'idle') return;
    var cfg = this.cfg, L = cfg.levels || {}, self = this;
    this._arm();
    this.t = 0;
    this._capIdx = -1;
    this._bellDone = false;
    this._narrState = 'pending';   // pending | playing | waiting | ended | failed
    this._finished = false;
    this._clearTimers();

    this.wasAutoRotate = !!(this.cam.view() && this.cam.view().autoRotate);
    this.cam.setAutoRotate(false);

    // media elements — created and "unlocked" inside the gesture
    this.narr = cfg.narration ? this._media(cfg.narration, L.narration != null ? L.narration : 1) : null;
    this.music = cfg.music ? this._media(cfg.music, 0) : null;
    this.bell = cfg.bell ? this._media(cfg.bell, L.bell != null ? L.bell : 0.5) : null;
    var n = this.narr;
    if (n) {
      n.addEventListener('playing', function () { if (self._narrState !== 'ended') self._narrState = 'playing'; });
      n.addEventListener('waiting', function () { if (self._narrState === 'playing') self._narrState = 'waiting'; });
      n.addEventListener('ended', function () { self._narrState = 'ended'; self._narrEndT = self.t; });
      n.addEventListener('error', function () { self._narrState = 'failed'; });
      // unlock for iOS: play+pause within the gesture, real start at narrationAt
      var p = n.play();
      if (p && p.catch) p.catch(function () {});
      n.pause();
      try { n.currentTime = 0; } catch (e) {}
    } else {
      this._narrState = 'failed';
    }
    if (this.bell) { var pb = this.bell.play(); if (pb && pb.catch) pb.catch(function () {}); this.bell.pause(); }
    if (this.music) {
      var pm = this.music.play();
      if (pm && pm.catch) pm.catch(function () {});
      this._fades.push(lerpVolume(this.music, L.music != null ? L.music : 0.2, 3000));
    }
    var sc = this.hooks.soundscape;
    if (sc) {
      try { sc.pauseEvents(true); sc.duck(L.soundscapeDuck != null ? L.soundscapeDuck : 0.35, 2); } catch (e) {}
      if (cfg.bell && sc.ctx) sc.loadBuffer('bell', cfg.bell);
    }
    if (this.hooks.duckAmbience) this.hooks.duckAmbience(L.ambienceDuck != null ? L.ambienceDuck : 0.16);

    this._setState('playing');
    this._last = performance.now();
    this._tick();
  };

  CinemaTour.prototype._tick = function () {
    var self = this;
    if (this.state !== 'playing') return;
    var now = performance.now(), dt = Math.min(0.25, (now - this._last) / 1000);
    this._last = now;
    var cfg = this.cfg, n = this.narr, at = cfg.narrationAt || 0;

    // --- clock ---
    if (this._narrState === 'pending' && this.t + dt >= at) {
      this.t = at;
      if (n) {
        var p = n.play();
        this._narrState = 'waiting';
        if (p && p.catch) p.catch(function () { self._narrState = 'failed'; });
      }
    } else if (this._narrState === 'waiting' && n && n.currentTime === 0 && n.readyState < 3) {
      // narration not started yet (buffering): hold the camera
    } else if ((this._narrState === 'playing' || this._narrState === 'waiting') && n) {
      if (n.readyState >= 3 && !n.paused) {
        this.t += dt;
        var target = at + n.currentTime, err = target - this.t;
        if (Math.abs(err) > this.stats.maxDrift) this.stats.maxDrift = Math.abs(err);
        if (Math.abs(err) > 0.3) { this.t = target; this.stats.snaps++; }
        else this.t += err * 0.15;
      }
      // else: buffering mid-speech -> hold
    } else {
      this.t += dt;   // pre-roll, after narration end, or narration failed
    }
    this.stats.ticks++;

    // --- camera ---
    this._sample(this.t, this._pose);
    this.cam.write(this._pose.lon, this._pose.lat, this._pose.fov);

    // --- bell ---
    if (!this._bellDone && cfg.bellAt != null && this.t >= cfg.bellAt) {
      this._bellDone = true;
      this._fireBell();
    }

    // --- music fade out ---
    var mf = cfg.musicFadeOut;
    if (mf && this.music && !this._musicFading && this.t >= mf[0]) {
      this._musicFading = true;
      this._fades.push(lerpVolume(this.music, 0, (mf[1] - mf[0]) * 1000));
    }

    // --- captions ---
    this._captions();

    if (this.t >= cfg.duration) { this._finish('end'); return; }
    this._timer = setTimeout(function () { self._tick(); }, TICK_MS);
  };

  CinemaTour.prototype._fireBell = function () {
    var L = this.cfg.levels || {}, vol = L.bell != null ? L.bell : 0.5;
    var sc = this.hooks.soundscape;
    this.stats.bell = { t: this.t, narr: this.narr ? this.narr.currentTime : null, via: 'none' };
    // spatial path (pans with the camera) if the soundscape has the buffer; else plain element
    if (sc && !sc.failed && sc.ctx && sc.ctx.state === 'running' && sc.playOneShot('bell', this.cfg.bellLon || 0, vol, { direct: true })) {
      this.stats.bell.via = 'webaudio';
      return;
    }
    if (this.bell) {
      try { this.bell.currentTime = 0; } catch (e) {}
      var p = this.bell.play();
      if (p && p.catch) p.catch(function () {});
      this.stats.bell.via = 'element';
    }
  };

  CinemaTour.prototype._captions = function () {
    var caps = this.cfg.captions, cb = this.hooks.onCaption;
    if (!caps || !cb) return;
    var idx = -1;
    for (var i = 0; i < caps.length; i++) if (this.t >= caps[i].t && this.t < caps[i].e) { idx = i; break; }
    if (idx !== this._capIdx) { this._capIdx = idx; cb(idx >= 0 ? caps[idx].text : null); }
  };

  CinemaTour.prototype._clearTimers = function () {
    clearTimeout(this._timer);
    for (var i = 0; i < this._fades.length; i++) clearInterval(this._fades[i]);
    this._fades.length = 0;
    this._musicFading = false;
  };

  CinemaTour.prototype._restore = function (reason) {
    var sc = this.hooks.soundscape;
    if (sc) { try { sc.duck(1, 2.5); sc.pauseEvents(false); } catch (e) {} }
    if (this.hooks.duckAmbience) this.hooks.duckAmbience(1, reason);
    if (this.hooks.onCaption) this.hooks.onCaption(null);
    this.cam.setAutoRotate(this.wasAutoRotate);
  };

  CinemaTour.prototype._stopMedia = function (ms) {
    var els = [this.narr, this.music, this.bell];
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        if (!el) return;
        if (el.paused) { el.removeAttribute('src'); return; }
        lerpVolume(el, 0, ms, function () { try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {} });
      })(els[i]);
    }
    this.narr = this.music = this.bell = null;
  };

  CinemaTour.prototype._finish = function (reason) {
    if (this._finished) return;
    this._finished = true;
    this._clearTimers();
    var last = this.K.t.length - 1;
    this.cam.write(this.K.lon[last], this.K.lat[last], this.K.fov[last]);
    this._stopMedia(800);
    this._restore(reason);
    this._setState('idle');
    if (this.hooks.onFinish) this.hooks.onFinish(reason);
  };

  /* Graceful cancel: camera stays where the user took it, audio fades. */
  CinemaTour.prototype.cancel = function (reason, detail) {
    if (this.state === 'idle' || this._finished) return;
    this._finished = true;
    this.lastCancel = detail || reason;
    this._clearTimers();
    this._stopMedia(CANCEL_FADE_MS);
    this._restore(reason || 'user');
    this._setState('idle');
    if (this.hooks.onFinish) this.hooks.onFinish(reason || 'user');
  };

  window.CinemaTour = CinemaTour;
})();
