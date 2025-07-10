import React, { useEffect, useRef, useState } from 'react';
import * as PIXI from 'pixi.js';

function PixiAudioVis({ url }) {
  const containerRef = useRef(null);
  const appRef = useRef();
  const graphicsRef = useRef();
  const [frequency, setFrequency] = useState(2);
  const [amplitude, setAmplitude] = useState(1);
  const [saved, setSaved] = useState(() => JSON.parse(localStorage.getItem('pixiSavedWaves') || '[]'));
  const [selected, setSelected] = useState(null);

  // Save waveform to localStorage
  function saveCurrentWaveform(data) {
    const name = prompt('Name for this waveform?');
    if (!name) return;
    const newSaved = [...saved, { name, data: Array.from(data) }];
    setSaved(newSaved);
    localStorage.setItem('pixiSavedWaves', JSON.stringify(newSaved));
  }

  // Load waveform from saved
  function loadSavedWave(index) {
    setSelected(index);
  }

  useEffect(() => {
    let destroyed = false;
    let ws;
    const containerNode = containerRef.current;
    if (!containerNode) return;

    // --- Visualization history buffer ---
    const HISTORY_SIZE = 100; // 100x slower
    let history = [];
    let bufferLen = 0;
    let scrollOffset = 0; // For smooth scrolling
    const SCROLL_SPEED = 2; // pixels per frame (adjust for slower/faster scroll)

    async function setupPixi() {
      const app = new PIXI.Application();
      await app.init({ width: 600, height: 300, background: '#222' });
      if (destroyed) {
        app.destroy(true, { children: true });
        return;
      }
      appRef.current = app;
      if (app.canvas && containerNode) {
        containerNode.appendChild(app.canvas);
      }
      // Add animated background using Pixi.js filter
      const bg = new PIXI.Graphics();
      app.stage.addChild(bg);
      let bgHue = 0;
      // --- HSV to RGB helper ---
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
        // Animated color gradient background
        for (let i = 0; i < app.canvas.height; i += 4) {
          const hue = (bgHue + i / 8) % 360;
          const sat = 0.7;
          const val = 0.25 + 0.25 * Math.sin(Date.now() / 1000 + i);
          const color = hsvToRgb(hue, sat, val);
          bg.fill({ color });
          bg.drawRect(0, i, app.canvas.width, 4);
          bg.fill();
        }
        bgHue = (bgHue + 0.2) % 360;
      }
      app.ticker.add(drawBackground);

      // Draw blue rectangle (test)
      const rect = new PIXI.Graphics();
      rect.fill({ color: 0x61dafb });
      rect.drawRect(200, 100, 200, 100);
      rect.fill();
      app.stage.addChild(rect);
      setTimeout(() => {
        if (destroyed || !app.stage) return;
        app.stage.removeChild(rect);
        rect.destroy();
        startAudioVis(app, containerNode);
      }, 1000);

      function startAudioVis(app, containerNode) {
        const graphics = new PIXI.Graphics();
        app.stage.addChild(graphics);
        graphicsRef.current = graphics;
        let lastData = null;
        ws = new window.WebSocket(url);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {};
        ws.onmessage = (event) => {
          let arr;
          if (event.data instanceof ArrayBuffer) {
            arr = new Float32Array(event.data);
            lastData = arr;
            if (selected !== null && saved[selected]) {
              arr = new Float32Array(saved[selected].data);
            }
            // --- History buffer logic ---
            if (history.length === 0) bufferLen = arr.length;
            if (arr.length === bufferLen) {
              history.push(Array.from(arr));
              if (history.length > HISTORY_SIZE) history.shift();
            }
            // Don't call drawWaveform here, let ticker handle it for smooth scroll
            return;
          }
          if (event.data instanceof Blob) {
            const reader = new FileReader();
            reader.onload = () => {
              let arr = new Float32Array(reader.result);
              lastData = arr;
              if (selected !== null && saved[selected]) {
                arr = new Float32Array(saved[selected].data);
              }
              if (history.length === 0) bufferLen = arr.length;
              if (arr.length === bufferLen) {
                history.push(Array.from(arr));
                if (history.length > HISTORY_SIZE) history.shift();
              }
              // Don't call drawWaveform here
            };
            reader.readAsArrayBuffer(event.data);
            return;
          }
        };
        function drawWaveform() {
          graphics.clear();
          // Draw nothing, background is handled by bg
          // Draw red center line
          graphics.beginPath();
          graphics.setStrokeStyle({ width: 1, color: 0xff0000 });
          graphics.moveTo(0, app.canvas.height / 2);
          graphics.lineTo(app.canvas.width, app.canvas.height / 2);
          graphics.stroke();
          // Draw waveform history as slow scrolling
          graphics.beginPath();
          graphics.setStrokeStyle({ width: 2, color: 0x61dafb });
          const w = app.canvas.width;
          const h = app.canvas.height;
          const total = bufferLen * HISTORY_SIZE;
          if (history.length > 0) {
            // Calculate pixel per sample
            const pxPerSample = w / total;
            // Offset for smooth scroll
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
        // Animate scroll
        app.ticker.add(() => {
          scrollOffset += SCROLL_SPEED;
          const w = app.canvas.width;
          const total = bufferLen * HISTORY_SIZE;
          const pxPerSample = w / total;
          if (scrollOffset > pxPerSample * bufferLen) {
            scrollOffset = 0;
          }
          drawWaveform();
        });
        // Save button handler
        window.savePixiWave = () => {
          if (lastData) saveCurrentWaveform(lastData);
        };
      }
    }
    setupPixi();
    return () => {
      destroyed = true;
      if (ws) ws.close();
      const app = appRef.current;
      if (app && app.canvas && containerNode && containerNode.contains(app.canvas)) {
        containerNode.removeChild(app.canvas);
      }
      if (app) app.destroy(true, { children: true });
    };
  }, [url, amplitude, selected]);

  return (
    <div style={{ position: 'relative', width: 600, height: 340, background: '#222', paddingTop: 40 }}>
      <div ref={containerRef} style={{ width: '100%', height: 300 }} />
      <div style={{ position: 'absolute', top: 0, left: 0, width: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
        <label>Amplitude
          <input type="range" min="0.1" max="2" step="0.01" value={amplitude} onChange={e => setAmplitude(Number(e.target.value))} />
        </label>
        <button onClick={() => {
          const el = appRef.current?.canvas;
          if (el && el.requestFullscreen) el.requestFullscreen();
        }}>Fullscreen</button>
        <button onClick={() => window.savePixiWave()}>Save</button>
        <select value={selected ?? ''} onChange={e => loadSavedWave(e.target.value === '' ? null : Number(e.target.value))}>
          <option value=''>Live</option>
          {saved.map((item, i) => (
            <option key={i} value={i}>{item.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default PixiAudioVis;
