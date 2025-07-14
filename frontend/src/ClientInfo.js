import React, { useEffect, useState } from 'react';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:8000';

function ClientInfo() {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  async function fetchInfo() {
    try {
      const res = await fetch(`${API_BASE}/clients`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setInfo(data);
      setError(null);
    } catch (e) {
      setError('Could not fetch client info');
      setInfo(null);
    }
  }

  useEffect(() => {
    fetchInfo();
    const interval = setInterval(fetchInfo, 60000); // every 60s
    return () => clearInterval(interval);
  }, []);

  if (error) return <div style={{ color: 'red', fontSize: 14 }}>Client info: {error}</div>;
  if (!info) return <div style={{ color: '#aaa', fontSize: 14 }}>Client info: Loading...</div>;
  return (
    <div style={{ color: '#aaa', fontSize: 14, marginTop: 4 }}>
      <b>Clients:</b> audio={info.audio_clients}, waveform={info.waveform_clients}
    </div>
  );
}

export default ClientInfo;
