# First recording session protocol

This is the procedure for the first set of DJI Neo 2 recordings. Its purpose is not
tidiness. Every analysis this repository performs rests on facts that cannot be
recovered afterwards — which microphone was which, which way the cube faced, what the
sound speed was, when the recording started relative to the Remote ID stream — and a
take missing any of them is not a weaker measurement but an unusable one.

Read the whole document before going out. Several steps are ordered because a later
one cannot be redone if an earlier one was skipped.

## What cannot be fixed in post-processing

- **Channel mapping.** A swapped pair rotates every azimuth the array will ever
  report, and nothing in a flight recording reveals it. It must be measured with the
  calibration tone, before flying.
- **Cube orientation.** Array azimuth zero is microphone 1. If the bearing microphone 1
  faced was not written down, no comparison with Remote ID is possible.
- **Time sync.** Remote ID timestamps are absolute; the audio timeline starts at zero.
  Without the `TIME SYNC` line that ties them together, ground truth is unusable. One
  second of misalignment is twelve metres of position error at cruising speed.
- **Edge length.** The design range is 350–400 mm and the analyzer defaults to 384 mm.
  Measure the actual edge with calipers, to the millimetre. A 2 mm error is 0.5 % on
  every delay-derived angle.
- **Clipping.** A clipped microphone fabricates a harmonic series indistinguishable
  from a rotor comb. Once it is in the file, the take is worthless for signature work.

## Equipment

- Detection cube, 6 microphones, 48 kHz, 24-bit, 6-channel UAC2.
- Laptop with the analyzer, plus enough disk for uncompressed audio: six channels at
  48 kHz and 24-bit is 864 kB/s, about 52 MB per minute.
- DJI Neo 2 with a **Dronetag Mini** fitted. Native Remote ID cannot be enabled in the
  Czech Republic, so the external module is the only source of position truth.
- BLE scanner running `dronetag.py`, writing `adv_payloads.ndjson`.
- Tape measure or laser rangefinder, at least 50 m.
- Compass or a phone with a reliable one, for the cube's bearing.
- Thermometer, hygrometer, and either a barometer or the nearest station's pressure.
- Anemometer if available; otherwise record the Beaufort estimate.
- Marker stakes or cones at the measured distances.

## Before leaving

1. Note the firmware version and commit on the cube.
2. Note the analyzer version and commit; every export carries them, so they should
   match what the notes say.
3. Confirm the Mini is charged, paired, and advertising. Check that the scanner is
   producing Location messages, not only Basic ID — a file with no Location messages
   contains no position at all.
4. Weigh the aircraft with the module fitted, and write the figure down. The stock
   airframe is 151 g and the Mini is 32 g, so hover rotor speed will run about 10 %
   above stock. Every recording made this way is acoustically the instrumented
   aircraft, not the one the detector must eventually recognise, which is why
   signatures are built from relative quantities rather than absolute f0.

## Site

- Open ground, at least 100 m clear in the direction the distance series will run.
- Away from roads, machinery, and standing water. Note anything audible that cannot be
  removed: a motorway 400 m off will be in every take.
- Wind under 3 m/s if at all possible. Wind is not just background noise: it is
  uncorrelated between microphones, so it destroys coherence and with it every delay
  estimate, and it produces energy without structure, which is exactly the case
  a purely energy-based classifier gets wrong.

## Session steps, in order

### 1. Set up and record the conditions

Place the cube on its stand, level, at least 1 m above the ground and away from
reflecting surfaces. Then record, in the session notes:

| Field | Notes |
| --- | --- |
| Date and local time | With timezone. |
| Cube position | Latitude and longitude to six decimals, from a phone or handheld GNSS. |
| Cube height above the take-off point | Measured, not estimated. The analyzer needs it to turn Remote ID height into elevation. |
| Bearing microphone 1 faces | Degrees true. This is array azimuth zero. |
| Measured edge length | Millimetres, with calipers. |
| Temperature, humidity, pressure | Sound speed follows from these; 15 °C to 25 °C moves it by about 6 m/s, which is 2 % on every angle. |
| Wind speed and direction | Direction relative to the cube. |
| Background sources | Roads, aircraft, livestock, machinery. |

### 2. Channel mapping calibration

Play the calibration sequence — 1 kHz for 100 ms into each microphone in turn — and
record it as `NN_calibration_mapping.wav`. Load it in the analyzer's **Array health**
tab and run the mapping check. Every slot must report the channel it should, with a
margin above 12 dB.

If the check fails, stop and fix the wiring. Do not proceed and plan to correct it
later: the correction is a permutation, and applying the wrong one produces a
plausible, wrong answer.

### 3. Background reference

With nothing flying and the site as quiet as it will get, record 60 seconds as
`NN_background.wav`. This take establishes:

- the array's self-noise per band, which is the floor every detection threshold must
  clear;
- whether the six microphones are matched, from the spread of their noise floors;
- whether the channels are uncorrelated, which they must be if their noise is their
  own.

Run **Array health** and the band metrics on it before flying. A channel 6 dB from the
median is a real problem and there is no per-channel gain correction anywhere in the
project.

### 4. Time sync

Start the audio recording and the BLE scanner, then trigger the firmware's `TIME SYNC`
line. Write the epoch it reports into the session notes as well as capturing the serial
log — the log is authoritative, the note is the backup.

Do this at the start of every take, not once for the session. Clocks drift, and a
recording that ran out of buffer and restarted has a new zero.

### 5. Ground truth check

Before the first flight, hold the aircraft (powered, rotors stopped) at a measured
distance and bearing from the cube, for 30 seconds. Compare what Remote ID reports
against the tape measure.

This is the only opportunity to find out whether the GNSS fix is honest. At 10 m a
3 m horizontal error is 17 degrees, against an array resolution near 1.07 degrees, so
close-range truth has to come from the tape rather than from the module. Note the
horizontal accuracy the module reports and whether it matches reality.

### 6. Distance series

Hover at 5 m altitude at each of 10, 20, 30, 50, 75 and 100 m ground distance, along a
single bearing, 30 seconds at each. Mark the positions with stakes beforehand.

Name each take `NN_distance_<metres>m_hover.wav`.

This series answers the question the whole system exists to answer: how far away the
aircraft can still be heard. Expect the top of the band to disappear first — air
absorption at 6 kHz is roughly ten times what it is at 1 kHz, so at 100 m the harmonics
above 4 kHz may be entirely gone while the fundamental survives.

### 7. Azimuth series

At a fixed 30 m, hover at 5 m altitude at azimuths of 0, 45, 90, 135, 180, 225, 270 and
315 degrees relative to microphone 1, 20 seconds each.

Name each take `NN_azimuth_<degrees>deg_30m.wav`.

This is what the direction-of-arrival work will be judged against, and it is also where
grating lobes will show themselves: the array is spatially aliased above about 447 Hz on
the long baseline, so the whole drone band is ambiguous and the ambiguity pattern
depends on direction.

### 8. Elevation series

At 30 m ground distance, hover at 5, 15, 30 and 50 m altitude, 20 seconds each. Above
about 45 degrees of elevation the geometry degrades in a specific way that has to be
measured rather than predicted.

### 9. Flight modes

At 30 m, 20 to 30 seconds each:

- take-off and climb from the ground;
- steady hover;
- horizontal pass across the array at constant altitude and speed;
- approach directly towards the cube;
- departure directly away;
- rapid climb;
- rapid descent;
- landing.

Take-off and descent matter more than they look. Rotor speed changes fastest there, and
a descending aircraft unloads its rotors — which is where the fundamental drops below
the firmware's 800 Hz drone band edge. Whether that edge is in the right place is one of
the questions this session exists to answer.

### 10. Confusers

Record 30 seconds of each that is available, with no aircraft flying:

- wind alone, if the wind is up;
- a passing car or tractor;
- birdsong;
- a person walking nearby;
- a lawnmower or strimmer, which is the hardest case: a small two-stroke engine
  produces a harmonic comb in the same band as a rotor.

Name them `NN_confuser_<what>.wav`. A detector that has never been shown these has not
been evaluated.

### 11. Second session, same day

If time allows, repeat the hover at 30 m at the end of the session. Comparing it with
the morning's take shows how much of the day's variation is the aircraft and how much
is the air.

## Naming and metadata

Files are named `NN_<series>_<parameters>.wav`, with `NN` a two-digit sequence number in
recording order. Each recording has a sidecar `NN_....txt` carrying one event per line,
and the analyzer reads both.

Annotation lines are `<start> [<end>] <label> [key=value ...]`, for example:

```
12.40 38.90 hover distance_m=30 altitude_m=5 azimuth_deg=0
41.2 45.8 pass direction=left_to_right speed_mps=8
52.0 wind_gust
```

Timestamps may be seconds, `mm:ss`, or `hh:mm:ss.mmm`. Firmware serial lines can be
mixed into the same file; they are recognised and kept separately.

For each take, record in the session notes:

- take number and file name;
- what was flown and where;
- distance and azimuth as intended, and as measured if they differ;
- anything that went wrong: a dropout, a gust, a car passing, a bystander.

The last of these is the most valuable and the most often skipped. An unexplained
anomaly in a spectrogram six months later is a puzzle; the same anomaly with "tractor
in the next field at 14:20" beside it is data.

## After the session

1. Copy the audio, the annotation files, `adv_payloads.ndjson` and the serial logs into
   one directory per session.
2. Load each take in the analyzer and run **Array health** before anything else. Any
   take with a dead or clipped channel is set aside.
3. Confirm the Remote ID track loads and lines up with the audio. If the interpolated
   truth covers only part of the take, the BLE was dropping frames, and the analyzer
   reports how many by counter gap.
4. Measure the real blade-pass frequency from the hover takes. Everything in the
   presets about the Neo 2's rotor speed is currently derived from thrust — 38 g per
   rotor over a 2.45e-3 m² disc, giving an induced velocity near 7.9 m/s and hover
   somewhere between 20000 and 35000 rpm — because DJI publishes no figure. Replacing
   that estimate with a measurement is the first thing the recordings are for.
5. Extract signatures only from steady hovers. A template built from a manoeuvre
   records the spread of the manoeuvre rather than the character of the aircraft.
6. Note in the session file that every take carries the Dronetag Mini's mass. When
   stock-configuration recordings become possible, the same series should be repeated
   without it, and the two compared — the difference is the measurement that justifies
   the whole RPM-invariant design.

## What a good session produces

- One calibration take that passes the mapping check.
- One background take with all six noise floors within a few dB of each other.
- Six distance takes, eight azimuth takes, four elevation takes, eight flight-mode
  takes, and as many confusers as the site offered.
- A Remote ID file covering all of them, on a timeline tied to the audio.
- A measured blade-pass frequency, which replaces an estimate that has been carried
  through the entire codebase until now.
