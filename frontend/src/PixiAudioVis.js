import React, { useEffect, useRef } from 'react';
import * as PIXI from 'pixi.js';

function PixiAudioVis({ url }) {
  const containerRef = useRef();
  const appRef = useRef();
  const wsRef = useRef();
  const graphicsRef = useRef();

  useEffect(() => {
    // Setup PixiJS app
    const app = new PIXI.Application({ width: 600, height: 300, background: '#222' });
    containerRef.current.appendChild(app.view);
    appRef.current = app;
    const graphics = new PIXI.Graphics();
    app.stage.addChild(graphics);
    graphicsRef.current = graphics;

    // Setup WebSocket
    const ws = new window.WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      // Assume Float32Array PCM data
      const arr = new Float32Array(event.data);
      drawWaveform(arr);
    };
    wsRef.current = ws;

    function drawWaveform(data) {
      graphics.clear();
      graphics.lineStyle(2, 0x61dafb);
      const len = data.length;
      const w = app.view.width;
      const h = app.view.height;
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * w;
        const y = h / 2 + data[i] * h / 2;
        if (i === 0) graphics.moveTo(x, y);
        else graphics.lineTo(x, y);
      }
    }

    return () => {
      ws.close();
      app.destroy(true, { children: true });
    };
  }, [url]);

  return <div ref={containerRef} />;
}

export default PixiAudioVis;
