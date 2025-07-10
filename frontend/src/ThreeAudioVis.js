import React, { useEffect, useRef } from 'react';
import { Canvas } from '@react-three/fiber';

function Bars({ data }) {
  // Simple bar visualization
  return (
    <group>
      {data.map((v, i) => (
        <mesh key={i} position={[i - data.length / 2, v * 10, 0]}>
          <boxGeometry args={[0.8, Math.max(0.1, v * 20), 0.8]} />
          <meshStandardMaterial color={0x61dafb} />
        </mesh>
      ))}
    </group>
  );
}

function Scene({ data }) {
  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} />
      <Bars data={data} />
    </>
  );
}

function ThreeAudioVis({ url }) {
  const [data, setData] = React.useState(new Array(32).fill(0));
  const wsRef = useRef();

  useEffect(() => {
    const ws = new window.WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      // Robust decoding for Float32Array
      let arr;
      if (event.data instanceof ArrayBuffer) {
        arr = new Float32Array(event.data);
      } else if (event.data instanceof Blob) {
        const reader = new FileReader();
        reader.onload = () => {
          const buffer = reader.result;
          const arr = new Float32Array(buffer);
          console.log("ThreeAudioVis received (Blob):", arr.slice(0, 10));
          updateBars(arr);
        };
        reader.readAsArrayBuffer(event.data);
        return;
      } else {
        console.warn("Unknown WebSocket data type", event.data);
        return;
      }
      console.log("ThreeAudioVis received:", arr.slice(0, 10));
      updateBars(arr);
    };
    ws.onclose = (e) => {
      console.log("Three WebSocket closed", e);
    };
    ws.onerror = (e) => {
      console.log("Three WebSocket error", e);
    };
    function updateBars(arr) {
      const step = Math.floor(arr.length / 32);
      const bars = Array.from({ length: 32 }, (_, i) => arr[i * step] || 0);
      setData(bars);
    }
    wsRef.current = ws;
    return () => ws.close();
  }, [url]);

  return (
    <div style={{ width: 600, height: 300 }}>
      <Canvas camera={{ position: [0, 0, 40], fov: 60 }}>
        <Scene data={data} />
      </Canvas>
    </div>
  );
}

export default ThreeAudioVis;
