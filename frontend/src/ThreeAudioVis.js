import React, { useEffect, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';

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
      // Assume Float32Array PCM data, downsample for bars
      const arr = new Float32Array(event.data);
      const step = Math.floor(arr.length / 32);
      const bars = Array.from({ length: 32 }, (_, i) => arr[i * step] || 0);
      setData(bars);
    };
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
