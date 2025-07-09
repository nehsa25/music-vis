import React, { useState } from 'react';
import { Box, FormControl, InputLabel, MenuItem, Select, Typography } from '@mui/material';
import PixiAudioVis from './PixiAudioVis';
import ThreeAudioVis from './ThreeAudioVis';
import './App.css';

function App() {
  const [visType, setVisType] = useState('pixi');

  return (
    <div className="App">
      <header className="App-header">
        <Typography variant="h4" gutterBottom>
          Audio Visualizer
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
        {visType === 'pixi' ? <PixiAudioVis url="ws://127.0.0.1:8000/audio" /> : <ThreeAudioVis url="ws://127.0.0.1:8000/audio" />}
      </header>
    </div>
  );
}

export default App;
