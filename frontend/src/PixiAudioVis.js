import React, { useEffect, useRef, useState } from 'react';
import * as PIXI from 'pixi.js';
import ClientInfo from './ClientInfo';

const API_BASE = 'http://192.168.0.59:8000';

function isMobileDevice() {
  return /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
}

function PixiAudioVis({ url }) {
  const containerRef = useRef(null);
  const appRef = useRef();
  // Default to 'raw' for all devices, but force 'raw' on mobile/tablet
  const [visMode, setVisMode] = useState(isMobileDevice() ? 'raw' : 'raw');
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rawRows, setRawRows] = useState([]); // Store previous rows for raw mode
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef();
  const MAX_ROWS = 300;
  const [wsError, setWsError] = useState(false);

  // WebSocket for volume
  useEffect(() => {
    const ws = new window.WebSocket(url);
    ws.onmessage = (event) => {
      try {
        setWsError(false);
        // Always use only the latest event, discard any backlog
        const msg = JSON.parse(event.data);
        if (typeof msg.volume === 'number') {
          const vol = Math.max(1, Math.min(500, Math.round(msg.volume)));
          setVolume(vol);
          setRawRows(prev => {
            if (paused) return prev; // Do not update if paused
            const dashCount = Math.max(1, Math.min(200, Math.round(vol / 2.5)));
            const newRows = [...prev, { dashes: '-'.repeat(dashCount), vol }];
            // Limit to MAX_ROWS for memory
            if (newRows.length > MAX_ROWS) newRows.shift();
            return newRows;
          });
        }
      } catch (e) {}
    };
    ws.onopen = () => {
      setRawRows([]);
      setWsError(false);
    };
    ws.onerror = () => {
      setWsError(true);
    };
    ws.onclose = () => {
      setWsError(true);
    };
    return () => ws.close();
  }, [url, paused]);

  // Scroll to end when unpaused
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [paused, rawRows]);

  // Pixi.js simple visualization
  useEffect(() => {
    let cancelled = false;
    async function setupPixi() {
      if (visMode !== 'pixi') {
        if (appRef.current) {
          appRef.current.destroy(true, { children: true });
          appRef.current = null;
        }
        return;
      }
      let app = appRef.current;
      if (!app) {
        app = await PIXI.Application.create({
          width: 600,
          height: 200,
          background: '#222',
          antialias: true,
          resolution: window.devicePixelRatio || 1,
        });
        if (cancelled) {
          app.destroy(true, { children: true });
          return;
        }
        appRef.current = app;
        if (containerRef.current) {
          containerRef.current.innerHTML = '';
          containerRef.current.appendChild(app.view);
        }
      }
      let graphics = new PIXI.Graphics();
      app.stage.removeChildren();
      app.stage.addChild(graphics);
      function draw() {
        graphics.clear();
        // Draw a bar whose width is proportional to volume
        const w = app.screen.width;
        const h = app.screen.height;
        const barW = (volume / 500) * (w - 40);
        graphics.beginFill(0x61dafb);
        graphics.drawRoundedRect(20, h / 2 - 20, barW, 40, 20);
        graphics.endFill();
        // Draw the volume number
        const style = new PIXI.TextStyle({ fill: '#fff', fontSize: 28, fontWeight: 'bold' });
        const text = new PIXI.Text(volume.toString(), style);
        text.x = w / 2 - text.width / 2;
        text.y = h / 2 - text.height / 2;
        app.stage.addChild(text);
      }
      app.ticker.add(draw);
      return () => {
        app.ticker.remove(draw);
        app.stage.removeChildren();
        graphics.destroy();
      };
    }
    setupPixi();
    return () => { cancelled = true; };
  }, [visMode, volume]);

  // Fullscreen logic
  const handleFullscreen = () => {
    // Use the root div for fullscreen, not just the Pixi container
    const elem = document.documentElement;
    if (!isFullscreen) {
      if (elem.requestFullscreen) elem.requestFullscreen();
      else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
      else if (elem.mozRequestFullScreen) elem.mozRequestFullScreen();
      else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
      else if (document.msExitFullscreen) document.msExitFullscreen();
      setIsFullscreen(false);
    }
  };
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  // Visualization rendering
  let visContent = null;
  if (wsError) {
    visContent = (
      <div style={{ color: 'red', fontSize: 18, textAlign: 'center', width: '100%' }}>
        Unable to connect to audio server.<br />
        Please check your network or try again later.
      </div>
    );
  } else if (visMode === 'raw') {
    visContent = (
      <div
        ref={scrollRef}
        style={{
          fontSize: 18,
          color: '#61dafb',
          margin: 0,
          userSelect: 'none',
          width: '100%',
          height: '100%',
          overflowY: 'auto',
          background: 'transparent',
          padding: 0,
          whiteSpace: 'pre',
          fontFamily: 'monospace',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          alignItems: 'flex-start',
          textAlign: 'left',
        }}
      >
        {rawRows.map((row, i) => (
          row.vol > 0 ? <div key={i}>{row.dashes} {row.vol}</div> : null
        ))}
      </div>
    );
  } else if (visMode === 'pixi') {
    visContent = <div style={{ width: '100%', maxWidth: 600, height: 200 }} ref={containerRef} />;
  } else if (visMode === 'three') {
    visContent = (
      <div style={{ color: '#fff', fontSize: 24, textAlign: 'center', marginTop: 40 }}>
        [three-react-fiber visualization placeholder]<br />Volume: {volume}
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        position: 'fixed',
        top: 0,
        left: 0,
        background: '#222',
        zIndex: isFullscreen ? 1000 : 'auto',
        overflow: 'hidden',
        transition: 'all 0.2s',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 10, display: isFullscreen ? 'none' : 'block' }}>
        <select value={visMode} onChange={e => setVisMode(e.target.value)} style={{ fontSize: 18, marginRight: 12 }}>
          <option value="raw">Raw</option>
          <option value="pixi">Pixi.js</option>
          <option value="three">three-react-fiber</option>
        </select>
        <button onClick={handleFullscreen} style={{ fontSize: 18, marginRight: 12 }}>
          {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        </button>
        <button onClick={() => setPaused(p => !p)} style={{ fontSize: 18 }}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <ClientInfo />
      </div>
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {visContent}
      </div>
    </div>
  );
}

export default PixiAudioVis;
