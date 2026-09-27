/* WORLDSMITH directional soundscape — WebAudio layer on top of the ambience loop.
 *
 * - ONE AudioContext, created lazily inside a user gesture (unlock()).
 * - Anchored layers: synthesized wind (low band) and branch rustle (high band),
 *   each pinned to a world longitude. A 10 Hz control loop pans them with
 *   StereoPannerNode from the camera heading and darkens them with a lowpass
 *   when they are behind you (front/back cue that stereo panning alone lacks).
 * - Random event scheduler: one-shots every [min,max] s at a random world
 *   heading — distant filtered bell (reuses bell.mp3), wind gust, timber creak,
 *   crow calls — all synthesized except the bell. Events keep panning while
 *   they ring out as the user turns.
 * - No per-frame allocation: fixed voice slots, preallocated state objects.
 * - Every public method is failure-proof: any WebAudio exception flips the
 *   engine to `failed` and it goes silent; the pano is never affected.
 *
 * API: new CinemaAudio(cfg, cam)
 *   unlock()            -> bool   (call synchronously in a click handler)
 *   setEnabled(bool)             fade the whole soundscape in/out (suspends ctx when off)
 *   duck(k)                      scale soundscape level (1 = normal) — tour uses this
 *   pauseEvents(bool)            hold the random scheduler (tour narration)
 *   playOneShot(buffer-name, lon, gain, opts) -> bool
 *   loadBuffer(name, url)        fetch+decode into the named slot (Promise, never rejects)
 */
(function () {
  'use strict';

  var DEG = Math.PI / 180;
  var MAX_VOICES = 4;
  var TICK_MS = 100;

  function wrap180(d) { d = (d + 180) % 360; if (d < 0) d += 360; return d - 180; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  function CinemaAudio(cfg, cam) {
    this.cfg = cfg || {};
    this.cam = cam;
    this.ctx = null;
    this.failed = false;
    this.enabled = false;
    this.duckK = 1;
    this.eventsPaused = false;
    this.buffers = {};
    this.layers = [];          // anchored continuous layers
    this.voices = [];          // fixed slots for one-shots
    for (var i = 0; i < MAX_VOICES; i++) this.voices.push({ busy: false, lon: 0, pan: null, shade: null, gain: null, end: 0, nodes: null });
    this._tick = null;
    this._evtTimer = null;
    this._suspendTimer = null;
    this.stats = { events: 0, lastEvent: '', ticks: 0 };
  }

  CinemaAudio.prototype._fail = function (e) {
    if (this.failed) return;
    this.failed = true;
    this.enabled = false;
    if (window.console && console.warn) console.warn('[soundscape] disabled:', e && e.message || e);
    try { clearTimeout(this._tick); clearTimeout(this._evtTimer); } catch (x) {}
    try { if (this.ctx) this.ctx.close(); } catch (x) {}
  };

  CinemaAudio.prototype._panner = function () {
    var c = this.ctx;
    if (c.createStereoPanner) return c.createStereoPanner();
    var g = c.createGain(); g.pan = null; return g;   // no panning support: pass through
  };

  CinemaAudio.prototype._noise = function () {
    // 4 s of brown-ish noise, mono, generated once and shared by every noise user
    if (this._noiseBuf) return this._noiseBuf;
    var c = this.ctx, n = Math.floor(c.sampleRate * 4);
    var b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0), last = 0;
    for (var i = 0; i < n; i++) {
      var w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    // crossfade the loop point so the loop is seamless
    var xf = Math.floor(c.sampleRate * 0.05);
    for (var j = 0; j < xf; j++) { var k = j / xf; d[n - xf + j] = d[n - xf + j] * (1 - k) + d[j] * k; }
    this._noiseBuf = b;
    return b;
  };

  CinemaAudio.prototype._build = function () {
    var c = this.ctx, cfg = this.cfg;
    this.master = c.createGain();
    this.master.gain.value = 0;
    var comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp); comp.connect(c.destination);

    var noise = this._noise();
    var defs = cfg.layers || [
      { name: 'wind', lon: 180, gain: 0.5, band: [180, 700], q: 0.6, lfo: 0.06, gust: 0.11 },
      { name: 'branches', lon: 100, gain: 0.12, band: [2400, 4200], q: 0.9, lfo: 0.09, gust: 0.17 }
    ];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var src = c.createBufferSource(); src.buffer = noise; src.loop = true;
      src.loopStart = 0; src.playbackRate.value = 0.9 + 0.2 * Math.random();
      var bp = c.createBiquadFilter(); bp.type = 'bandpass';
      var f0 = (d.band[0] + d.band[1]) / 2;
      bp.frequency.value = f0; bp.Q.value = d.q;
      // filter sweep LFO (runs on the audio thread, zero JS cost)
      var lfo = c.createOscillator(); lfo.frequency.value = d.lfo;
      var lfoAmt = c.createGain(); lfoAmt.gain.value = (d.band[1] - d.band[0]) / 2;
      lfo.connect(lfoAmt); lfoAmt.connect(bp.frequency);
      var shade = c.createBiquadFilter(); shade.type = 'lowpass'; shade.frequency.value = 8000; shade.Q.value = 0.5;
      var g = c.createGain(); g.gain.value = d.gain;
      // gust LFO modulates amplitude around the base level
      var gl = c.createOscillator(); gl.frequency.value = d.gust;
      var glAmt = c.createGain(); glAmt.gain.value = d.gain * 0.45;
      gl.connect(glAmt); glAmt.connect(g.gain);
      var pan = this._panner();
      src.connect(bp); bp.connect(shade); shade.connect(g); g.connect(pan); pan.connect(this.master);
      src.start(0, Math.random() * 3); lfo.start(); gl.start();
      this.layers.push({ name: d.name, lon: d.lon, pan: pan, shade: shade, gain: g, base: d.gain });
    }
  };

  CinemaAudio.prototype.unlock = function () {
    if (this.failed) return false;
    try {
      if (!this.ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('no WebAudio');
        this.ctx = new AC({ latencyHint: 'playback' });
        this._build();
        if (this.cfg.bell) this.loadBuffer('bell', this.cfg.bell);
        if (this.cfg.crows) {
          this.loadBuffer('crow1', this.cfg.crows[0]);
          this.loadBuffer('crow2', this.cfg.crows[1] || this.cfg.crows[0]);
        }
      }
      if (this.ctx.state === 'suspended') {
        var self = this;
        var p = this.ctx.resume();
        if (p && p.catch) p.catch(function (e) { self._fail(e); });
      }
      return true;
    } catch (e) { this._fail(e); return false; }
  };

  CinemaAudio.prototype.loadBuffer = function (name, url) {
    var self = this;
    if (this.failed || !this.ctx) return Promise.resolve(null);
    if (this.buffers[name]) return Promise.resolve(this.buffers[name]);
    if (this['_ld_' + name]) return this['_ld_' + name];
    var p = fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return r.arrayBuffer();
    }).then(function (ab) {
      return new Promise(function (res, rej) {
        var q = self.ctx.decodeAudioData(ab, res, rej);  // callback form for old Safari
        if (q && q.catch) q.catch(rej);
      });
    }).then(function (buf) { self.buffers[name] = buf; return buf; })
      .catch(function () { return null; });   // missing asset = that event just never fires
    this['_ld_' + name] = p;
    return p;
  };

  CinemaAudio.prototype._level = function () {
    return (this.cfg.gain != null ? this.cfg.gain : 0.8) * this.duckK;
  };

  CinemaAudio.prototype.setEnabled = function (on) {
    if (this.failed || !this.ctx) return;
    try {
      var c = this.ctx, t = c.currentTime, self = this;
      this.enabled = !!on;
      clearTimeout(this._suspendTimer);
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      if (on) {
        if (c.state === 'suspended') c.resume();
        this.master.gain.linearRampToValueAtTime(this._level(), t + 1.2);
        this._startTick();
        this._scheduleEvent(true);
      } else {
        this.master.gain.linearRampToValueAtTime(0, t + 0.8);
        clearTimeout(this._evtTimer); this._evtTimer = null;
        // suspend after the fade: no audio thread work while muted (4GB laptop)
        this._suspendTimer = setTimeout(function () {
          if (!self.enabled && self.ctx && self.ctx.state === 'running') self.ctx.suspend();
          clearTimeout(self._tick); self._tick = null;
        }, 1000);
      }
    } catch (e) { this._fail(e); }
  };

  CinemaAudio.prototype.duck = function (k, secs) {
    this.duckK = k;
    if (this.failed || !this.ctx || !this.enabled) return;
    try {
      var t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(this._level(), t + (secs || 1.5));
    } catch (e) { this._fail(e); }
  };

  CinemaAudio.prototype.pauseEvents = function (p) {
    this.eventsPaused = !!p;
    if (!p && this.enabled) this._scheduleEvent(true);
  };

  // --- control loop: camera heading -> pan/shade for layers and live voices ---
  CinemaAudio.prototype._startTick = function () {
    if (this._tick) return;
    var self = this;
    function tick() {
      self._tick = null;
      if (self.failed || (!self.enabled && !self._anyBusy())) return;
      try { self._update(); } catch (e) { self._fail(e); return; }
      self._tick = setTimeout(tick, TICK_MS);
    }
    tick();
  };

  CinemaAudio.prototype._spatialize = function (lon, camLon, pan, shade, t) {
    var rel = wrap180(lon - camLon) * DEG;
    var front = Math.cos(rel);           // 1 ahead, -1 behind
    if (pan.pan) pan.pan.setTargetAtTime(Math.sin(rel) * 0.92, t, 0.08);
    // behind: roll off highs (1.1 kHz); ahead: open (9 kHz)
    shade.frequency.setTargetAtTime(1100 + 7900 * (front * 0.5 + 0.5), t, 0.12);
  };

  CinemaAudio.prototype._update = function () {
    var s = this.cam && this.cam.read();
    if (!s) return;
    var t = this.ctx.currentTime, camLon = s.lon, i;
    this.stats.ticks++;
    for (i = 0; i < this.layers.length; i++) {
      var L = this.layers[i];
      this._spatialize(L.lon, camLon, L.pan, L.shade, t);
    }
    for (i = 0; i < MAX_VOICES; i++) {
      var v = this.voices[i];
      if (!v.busy) continue;
      if (t > v.end) { this._release(v); continue; }
      this._spatialize(v.lon, camLon, v.pan, v.shade, t);
    }
  };

  CinemaAudio.prototype._anyBusy = function () {
    for (var i = 0; i < MAX_VOICES; i++) if (this.voices[i].busy) return true;
    return false;
  };

  CinemaAudio.prototype._voice = function () {
    for (var i = 0; i < MAX_VOICES; i++) if (!this.voices[i].busy) return this.voices[i];
    return null;
  };

  CinemaAudio.prototype._release = function (v) {
    v.busy = false;
    try {
      if (v.nodes) for (var i = 0; i < v.nodes.length; i++) { try { v.nodes[i].disconnect(); } catch (x) {} }
      v.pan.disconnect(); v.shade.disconnect(); v.gain.disconnect();
    } catch (e) {}
    v.nodes = null;
  };

  // Voice chain: <source(s)> -> v.gain -> v.shade -> v.pan -> dest
  CinemaAudio.prototype._openVoice = function (lon, dur, dest) {
    var v = this._voice();
    if (!v) return null;
    var c = this.ctx;
    v.busy = true; v.lon = lon; v.end = c.currentTime + dur + 0.3; v.nodes = [];
    v.gain = c.createGain(); v.gain.gain.value = 0;
    v.shade = c.createBiquadFilter(); v.shade.type = 'lowpass'; v.shade.frequency.value = 6000;
    v.pan = this._panner();
    v.gain.connect(v.shade); v.shade.connect(v.pan); v.pan.connect(dest || this.master);
    var s = this.cam && this.cam.read();
    if (s) {
      var rel = wrap180(lon - s.lon) * DEG;
      if (v.pan.pan) v.pan.pan.value = Math.sin(rel) * 0.92;
      v.shade.frequency.value = 1100 + 7900 * (Math.cos(rel) * 0.5 + 0.5);
    }
    this._startTick();
    return v;
  };

  /* One-shot from a decoded buffer at world heading `lon`.
   * opts: { lowpass, rate, dest: 'direct' (bypass soundscape master/duck) } */
  CinemaAudio.prototype.playOneShot = function (name, lon, gain, opts) {
    if (this.failed || !this.ctx) return false;
    var buf = this.buffers[name];
    if (!buf) return false;
    opts = opts || {};
    try {
      var c = this.ctx;
      if (c.state === 'suspended') c.resume();
      var dest = this.master;
      if (opts.direct) {
        if (!this._direct) { this._direct = c.createGain(); this._direct.connect(c.destination); }
        dest = this._direct;
      }
      var rate = opts.rate || 1;
      var v = this._openVoice(lon, buf.duration / rate, dest);
      if (!v) return false;
      var src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
      var node = src;
      if (opts.lowpass) {
        var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = opts.lowpass;
        src.connect(lp); node = lp; v.nodes.push(lp);
      }
      node.connect(v.gain); v.nodes.push(src);
      var t = c.currentTime;
      v.gain.gain.setValueAtTime(gain, t);
      src.start(t);
      if (opts.direct) this._startTick();
      return true;
    } catch (e) { this._fail(e); return false; }
  };

  // --- synthesized events ---
  CinemaAudio.prototype._gust = function (lon) {
    var c = this.ctx, dur = rnd(3.5, 6), v = this._openVoice(lon, dur);
    if (!v) return;
    var t = c.currentTime;
    var src = c.createBufferSource(); src.buffer = this._noise(); src.loop = true;
    var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.linearRampToValueAtTime(rnd(900, 1400), t + dur * 0.45);
    bp.frequency.linearRampToValueAtTime(320, t + dur);
    src.connect(bp); bp.connect(v.gain);
    var peak = rnd(0.35, 0.6);
    v.gain.gain.setValueAtTime(0, t);
    v.gain.gain.linearRampToValueAtTime(peak, t + dur * 0.4);
    v.gain.gain.linearRampToValueAtTime(peak * 0.6, t + dur * 0.6);
    v.gain.gain.linearRampToValueAtTime(0, t + dur);
    src.start(t, Math.random() * 3); src.stop(t + dur + 0.05);
    v.nodes.push(src, bp);
  };

  CinemaAudio.prototype._creak = function (lon) {
    // timber creak: an irregular low pulse train through a resonant bandpass
    var c = this.ctx, dur = rnd(1.2, 2.2), v = this._openVoice(lon, dur);
    if (!v) return;
    var t = c.currentTime;
    var osc = c.createOscillator(); osc.type = 'square';
    osc.frequency.setValueAtTime(rnd(18, 26), t);
    osc.frequency.linearRampToValueAtTime(rnd(40, 70), t + dur * 0.5);
    osc.frequency.linearRampToValueAtTime(rnd(14, 22), t + dur);
    var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 9;
    bp.frequency.setValueAtTime(rnd(500, 800), t);
    bp.frequency.linearRampToValueAtTime(rnd(900, 1300), t + dur);
    osc.connect(bp); bp.connect(v.gain);
    var pk = rnd(0.25, 0.4);
    v.gain.gain.setValueAtTime(0, t);
    v.gain.gain.linearRampToValueAtTime(pk, t + 0.15);
    v.gain.gain.setValueAtTime(pk, t + dur - 0.3);
    v.gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.start(t); osc.stop(t + dur + 0.05);
    v.nodes.push(osc, bp);
  };

  CinemaAudio.prototype._crow = function (lon) {
    // 2-3 hoarse descending caws, distant
    var c = this.ctx, n = 2 + (Math.random() < 0.5 ? 1 : 0), gap = rnd(0.42, 0.6);
    var dur = n * gap + 0.4, v = this._openVoice(lon, dur);
    if (!v) return;
    var t = c.currentTime;
    var osc = c.createOscillator(); osc.type = 'sawtooth';
    var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1350; bp.Q.value = 2.5;
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
    osc.connect(bp); bp.connect(lp); lp.connect(v.gain);
    v.gain.gain.setValueAtTime(0, t);
    var f = rnd(560, 680);
    for (var i = 0; i < n; i++) {
      var s = t + i * gap;
      osc.frequency.setValueAtTime(f, s);
      osc.frequency.exponentialRampToValueAtTime(f * 0.62, s + 0.28);
      v.gain.gain.setValueAtTime(0, s);
      v.gain.gain.linearRampToValueAtTime(0.16, s + 0.03);
      v.gain.gain.linearRampToValueAtTime(0.1, s + 0.2);
      v.gain.gain.linearRampToValueAtTime(0, s + 0.3);
    }
    osc.start(t); osc.stop(t + dur);
    v.nodes.push(osc, bp, lp);
  };

  CinemaAudio.prototype.fireEvent = function (kind, lon) {
    if (this.failed || !this.ctx || !this.enabled) return false;
    try {
      if (!kind) {
        var r = Math.random();
        if (this.cfg.crows) { kind = r < 0.5 ? 'crow' : r < 0.62 ? 'creak' : 'gust'; }
        else { kind = r < 0.3 && this.buffers.bell ? 'bell' : r < 0.55 ? 'gust' : r < 0.78 ? 'crow' : 'creak'; }
      }
      if (lon == null) {
        // bell and crows have a "home" in the world (tower offstage, rookery
        // tree) most of the time, so they become landmarks you can turn toward
        var ev = this.cfg.events || {}, home = kind === 'bell' ? ev.bellLon : kind === 'crow' ? ev.crowLon : null;
        lon = home != null && Math.random() < 0.7 ? home + rnd(-12, 12) : rnd(-180, 180);
      }
      if (kind === 'bell') {
        if (!this.playOneShot('bell', lon, rnd(0.1, 0.18), { lowpass: rnd(500, 800), rate: rnd(0.82, 0.95) })) kind = 'gust';
      }
      if (kind === 'crow' && this.buffers.crow1) {
        // real crow sample (raucous group or single caw), panned, slightly filtered
        var crowBuf = Math.random() < 0.55 ? 'crow1' : 'crow2';
        if (!this.playOneShot(crowBuf, lon, rnd(0.22, 0.38), { lowpass: rnd(3200, 5200), rate: rnd(0.9, 1.08) })) this._crow(lon);
      } else
      if (kind === 'gust') this._gust(lon);
      else if (kind === 'creak') this._creak(lon);
      else if (kind === 'crow') this._crow(lon);
      this.stats.events++; this.stats.lastEvent = kind + '@' + Math.round(lon);
      return true;
    } catch (e) { this._fail(e); return false; }
  };

  CinemaAudio.prototype._scheduleEvent = function (reset) {
    if (this.failed || !this.enabled) return;
    if (this._evtTimer && !reset) return;
    clearTimeout(this._evtTimer);
    var ev = this.cfg.events || {}, self = this;
    var min = ev.min != null ? ev.min : 20, max = ev.max != null ? ev.max : 60;
    this._evtTimer = setTimeout(function () {
      self._evtTimer = null;
      if (!self.enabled) return;
      if (!self.eventsPaused && !document.hidden) self.fireEvent();
      self._scheduleEvent();
    }, rnd(min, max) * 1000);
  };

  window.CinemaAudio = CinemaAudio;
})();
