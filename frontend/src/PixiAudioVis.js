import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as PIXI from 'pixi.js';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:8000';

function PixiAudioVis({ url }) {
  const containerRef = useRef(null);
  const appRef = useRef();
  const graphicsRef = useRef();
  const [amplitude, setAmplitude] = useState(1);
  const [saved, setSaved] = useState([]);
  const [selected, setSelected] = useState(null);
  const [visStyle, setVisStyle] = useState('waveform');
  const [waveformSpeed, setWaveformSpeed] = useState(0.002);
  const wsWaveformsRef = useRef(null);
  const [testComplete, setTestComplete] = useState(false);

  // --- Event counters (refs, never recreated) ---
  const eventsFiredRef = useRef(0);
  const eventsEchoedRef = useRef(0);
  const eventsReceivedRef = useRef(0);

  // Fetch shared waveforms on mount
  useEffect(() => {
    fetch(API_BASE + '/waveforms')
      .then(r => r.json())
      .then(setSaved);
    const ws = new window.WebSocket(API_BASE.replace('http', 'ws') + '/waveforms/ws');
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'update' && Array.isArray(msg.waveforms)) {
          setSaved(msg.waveforms);
        }
      } catch (e) { console.error('Waveform WS error', e); }
    };
    wsWaveformsRef.current = ws;
    return () => { ws.close(); };
  }, []);

  // Load waveform from saved
  const loadSavedWave = useCallback((index) => {
    setSelected(index);
  }, []);

  // --- Main Pixi.js and event logic ---
  useEffect(() => {
    let destroyed = false;
    let ws;
    let tickerFn = null;
    const containerNode = containerRef.current;
    if (!containerNode) return;

    // --- Visualization history buffer ---
    const HISTORY_SIZE = 20;
    let history = [];
    let bufferLen = 0;
    let scrollOffset = 0;
    let lastEntryTime = null;
    let lastExitTime = null;
    let receivedEventQueue = [];
    let echoing = false;
    let shutdownPosted = false;

    // --- Pixi.js setup ---
    const app = new PIXI.Application();
    app.init({ width: 600, height: 300, background: '#222' }).then(() => {
      if (destroyed) {
        app.destroy(true, { children: true });
        return;
      }
      appRef.current = app;
      if (app.canvas && containerNode) {
        containerNode.appendChild(app.canvas);
      }
      // Animated background
      const bg = new PIXI.Graphics();
      app.stage.addChild(bg);
      let bgHue = 0;
      function hsvToRgb(h, s, v) {
        h = h % 360;
        let c = v * s;
        let x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        let m = v - c;
        let r = 0, g = 0, b = 0;
        if (h < 60) [r, g, b] = [c, x, 0];
        else if (h < 120) [r, g, b] = [x, c, 0];
        else if (h < 180) [r, g, b] = [0, c, x];
        else if (h < 240) [r, g, b] = [0, x, c];
        else if (h < 300) [r, g, b] = [x, 0, c];
        else [r, g, b] = [c, 0, x];
        return ((Math.round((r + m) * 255) << 16) |
                (Math.round((g + m) * 255) << 8) |
                (Math.round((b + m) * 255)));
      }
      function drawBackground() {
        bg.clear();
        for (let i = 0; i < app.canvas.height; i += 4) {
          const hue = (bgHue + i / 8) % 360;
          const sat = 0.7;
          const val = 0.25 + 0.25 * Math.sin(Date.now() / 1000 + i);
          const color = hsvToRgb(hue, sat, val);
          bg.fill({ color });
          bg.rect(0, i, app.canvas.width, 4);
          bg.fill();
        }
        bgHue = (bgHue + 0.2) % 360;
      }
      tickerFn = drawBackground;
      app.ticker.add(drawBackground);

      // --- Main waveform visualization ---
      const graphics = new PIXI.Graphics();
      app.stage.addChild(graphics);
      graphicsRef.current = graphics;
      function draw() {
        graphics.clear();
        graphics.beginPath();
        graphics.setStrokeStyle({ width: 1, color: 0xff0000 });
        graphics.moveTo(0, app.canvas.height / 2);
        graphics.lineTo(app.canvas.width, app.canvas.height / 2);
        graphics.stroke();
        graphics.beginPath();
        graphics.setStrokeStyle({ width: 2, color: 0x61dafb });
        const w = app.canvas.width;
        const h = app.canvas.height;
        const total = bufferLen * HISTORY_SIZE;
        if (history.length > 0) {
          const pxPerSample = w / total;
          let x0 = -scrollOffset;
          for (let i = 0; i < total; i++) {
            const histIdx = Math.floor(i / bufferLen);
            const bufIdx = i % bufferLen;
            if (histIdx >= history.length) break;
            const x = x0 + i * pxPerSample;
            const y = h / 2 + history[histIdx][bufIdx] * h * 0.45 * amplitude;
            if (i === 0) graphics.moveTo(x, y);
            else graphics.lineTo(x, y);
          }
          graphics.stroke();
        }
      }
      app.ticker.add(draw);

      // --- WebSocket for audio events ---
      ws = new window.WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {};
      ws.onerror = (e) => {
        console.error('[PixiAudioVis] WebSocket error:', e);
      };
      ws.onclose = (e) => {
        if (e.code !== 1000) {
          console.error('[PixiAudioVis] WebSocket closed:', e);
        } else {
          console.log('[PixiAudioVis] WebSocket closed cleanly by server.');
        }
        // After close, keep echoing any remaining buffered events
        function sendShutdownPost() {
          if (window.__pixi_shutdown_posted) {
            console.warn('[SHUTDOWN POST] Attempted duplicate POST', {
              eventsFired: eventsFiredRef.current,
              eventsReceived: eventsReceivedRef.current,
              eventsEchoed: eventsEchoedRef.current,
              stack: new Error().stack
            });
            return;
          }
          window.__pixi_shutdown_posted = true;
          console.log('[SHUTDOWN POST]', {
            eventsFired: eventsFiredRef.current,
            eventsReceived: eventsReceivedRef.current,
            eventsEchoed: eventsEchoedRef.current,
            stack: new Error().stack
          });
          fetch(API_BASE + '/shutdown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              eventsFired: eventsFiredRef.current,
              eventsReceived: eventsReceivedRef.current,
              eventsEchoed: eventsEchoedRef.current
            })
          });
          if (appRef.current && appRef.current.ticker) appRef.current.ticker.stop();
        }
        function finishEchoing() {
          if (receivedEventQueue.length > 0) {
            tryEchoNext();
            setTimeout(finishEchoing, 10);
          } else if (
            eventsEchoedRef.current === eventsFiredRef.current &&
            eventsEchoedRef.current > 0 &&
            !window.__pixi_shutdown_posted
          ) {
            setTestComplete(true);
            sendShutdownPost();
          } else if (
            eventsFiredRef.current > 0 &&
            (eventsEchoedRef.current !== eventsFiredRef.current || receivedEventQueue.length > 0)
          ) {
            setTimeout(finishEchoing, 10);
          }
        }
        finishEchoing();
      };
      function tryEchoNext() {
        if (echoing || receivedEventQueue.length === 0) return;
        echoing = true;
        const { duration } = receivedEventQueue.shift();
        fetch(API_BASE + '/waveform_cross_time', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(duration ? { duration } : {})
        }).then(r => {
          if (r.ok) {
            eventsEchoedRef.current += 1;
            echoing = false;
            if (receivedEventQueue.length > 0) {
              tryEchoNext();
            } else if (
              eventsEchoedRef.current === eventsFiredRef.current &&
              eventsEchoedRef.current > 0 &&
              !shutdownPosted
            ) {
              shutdownPosted = true;
              setTestComplete(true);
              console.log('[SHUTDOWN POST]', {
                eventsFired: eventsFiredRef.current,
                eventsReceived: eventsReceivedRef.current,
                eventsEchoed: eventsEchoedRef.current
              });
              fetch(API_BASE + '/shutdown', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  eventsFired: eventsFiredRef.current,
                  eventsReceived: eventsReceivedRef.current,
                  eventsEchoed: eventsEchoedRef.current
                })
              });
              if (appRef.current && appRef.current.ticker) appRef.current.ticker.stop();
            }
          } else {
            echoing = false;
          }
        });
      }
      ws.onmessage = (event) => {
        try {
          let arr;
          if (event.data instanceof ArrayBuffer) {
            arr = new Float32Array(event.data);
            eventsFiredRef.current += 1;
            eventsReceivedRef.current += 1;
            // Diagnostic log for event counters
            console.log('[EVENT COUNTERS]', {
              eventsFired: eventsFiredRef.current,
              eventsReceived: eventsReceivedRef.current,
              eventsEchoed: eventsEchoedRef.current
            });
            if (selected !== null && saved[selected]) {
              arr = new Float32Array(saved[selected].data);
            }
            if (history.length === 0) bufferLen = arr.length;
            if (arr.length === bufferLen) {
              history.push(Array.from(arr));
              if (history.length > HISTORY_SIZE) history.shift();
              const w = app.canvas.width;
              const total = bufferLen * HISTORY_SIZE;
              const pxPerSample = w / total;
              if (scrollOffset === 0) {
                lastEntryTime = Date.now();
              }
              const minCrossTime = 1.2;
              const frameRate = 50;
              const minSpeed = 0.002;
              const speedFactor = waveformSpeed / minSpeed;
              const increment = w / (minCrossTime * frameRate) * speedFactor;
              scrollOffset += increment;
              if (scrollOffset > pxPerSample * bufferLen) {
                scrollOffset = 0;
                lastExitTime = Date.now();
              }
            }
            const duration = lastEntryTime && lastExitTime ? (lastExitTime - lastEntryTime) / 1000 : undefined;
            receivedEventQueue.push({ duration });
            tryEchoNext();
            return;
          }
          if (event.data instanceof Blob) {
            const reader = new FileReader();
            reader.onload = () => {
              let arr = new Float32Array(reader.result);
              if (selected !== null && saved[selected]) {
                arr = new Float32Array(saved[selected].data);
              }
              if (history.length === 0) bufferLen = arr.length;
              if (arr.length === bufferLen) {
                history.push(Array.from(arr));
                if (history.length > HISTORY_SIZE) history.shift();
                const w = app.canvas.width;
                const total = bufferLen * HISTORY_SIZE;
                const pxPerSample = w / total;
                scrollOffset += pxPerSample * bufferLen * waveformSpeed;
                if (scrollOffset > pxPerSample * bufferLen) {
                  scrollOffset = 0;
                }
              }
            };
            reader.readAsArrayBuffer(event.data);
            return;
          }
        } catch (err) {
          console.error('[PixiAudioVis] WebSocket message error:', err);
        }
      };
    });
    return () => {
      destroyed = true;
      if (ws) ws.close();
      const app = appRef.current;
      if (app && app.ticker && tickerFn) {
        try {
          app.ticker.remove(tickerFn);
        } catch (e) {}
      }
      if (app && app.stage) {
        app.stage.removeChildren().forEach(child => {
          if (child.destroy) child.destroy({ children: true });
        });
      }
      if (app && app.canvas && containerNode && containerNode.contains(app.canvas)) {
        containerNode.removeChild(app.canvas);
      }
      if (app) app.destroy(true, { children: true });
    };
  }, [url, amplitude, selected, visStyle, waveformSpeed, saved]);

  // --- Controls panel ---
  const handleAmplitudeChange = (e) => {
    setAmplitude(Math.max(0, e.target.value));
  };

  return (
    <div>
      <div ref={containerRef} style={{ width: '100%', height: '300px', position: 'relative' }} />
      {testComplete && (
        <div style={{ color: 'lime', fontWeight: 'bold', textAlign: 'center', marginTop: 10 }}>
          Test complete. Final counts sent to server.
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '10px' }}>
        <button onClick={() => { if (graphicsRef.current) graphicsRef.current.clear(); }}>
          Clear
        </button>
        <button onClick={() => { if (graphicsRef.current) graphicsRef.current.visible = !graphicsRef.current.visible; }}>
          Toggle Waveform
        </button>
        <select value={visStyle} onChange={e => setVisStyle(e.target.value)} style={{ marginLeft: 8 }}>
          <option value="waveform">Waveform</option>
          <option value="particles">Particle Swarm</option>
          <option value="lava">Fluid - Lava</option>
          <option value="water">Fluid - Water</option>
        </select>
        <label style={{ marginLeft: 8 }}>Amplitude
          <input type="range" min="0.1" max="2" step="0.01" value={amplitude} onChange={handleAmplitudeChange} />
        </label>
        <label style={{ marginLeft: 8 }}>Waveform Speed
          <input type="range" min="0.002" max="0.02" step="0.0001" value={waveformSpeed} onChange={e => setWaveformSpeed(Number(e.target.value))} />
        </label>
        <button onClick={() => window.savePixiWave()}>Save</button>
        <select value={selected ?? ''} onChange={e => loadSavedWave(e.target.value === '' ? null : Number(e.target.value))}>
          <option value=''>Live</option>
          {saved.map((item, i) => (
            <option key={i} value={i}>{item.name}</option>
          ))}
        </select>
        <button onClick={() => {
          const el = appRef.current?.canvas;
          if (el && el.requestFullscreen) el.requestFullscreen();
        }}>Fullscreen</button>
      </div>
    </div>
  );
}

export default PixiAudioVis;
