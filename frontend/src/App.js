import React, { useState, useEffect } from 'react';
import { Box, FormControl, InputLabel, MenuItem, Select, Typography } from '@mui/material';
import PixiAudioVis from './PixiAudioVis';
import ThreeAudioVis from './ThreeAudioVis';
import './App.css';

function App() {
  const [visType, setVisType] = useState('pixi');
  const [status, setStatus] = useState('Connecting to backend...');

  useEffect(() => {
    fetch('http://127.0.0.1:8000/')
      .then(res => res.json())
      .then(data => setStatus(data.status))
      .catch(() => setStatus('Could not connect to backend.'));
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <Typography variant="h4" gutterBottom>
          Audio Visualizer
        </Typography>
        <Typography variant="body1" color="secondary" gutterBottom>
          {status}
        </Typography>
        <Box sx={{ minWidth: 200, mb: 4 }}>
          <FormControl fullWidth>
            <InputLabel id="vis-type-label">Visualization</InputLabel>
            <Select
              labelId="vis-type-label"
              id="vis-type-select"
              value={visType}
              label="Visualization"
              onChange={e => setVisType(e.target.value)}
            >
              <MenuItem value="pixi">Pixi.js</MenuItem>
              <MenuItem value="three">React Three Fiber</MenuItem>
            </Select>
          </FormControl>
        </Box>
        {visType === 'pixi' ? <PixiAudioVis url="ws://localhost:8000/audio" /> : <ThreeAudioVis url="ws://localhost:8000/audio" />}
      </header>
    </div>
  );
}

export default App;
