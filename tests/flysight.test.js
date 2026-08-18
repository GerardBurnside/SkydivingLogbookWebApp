const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFlysight() {
    const filePath = path.join(__dirname, '..', 'js', 'flysight.js');
    const code = fs.readFileSync(filePath, 'utf8');
    const sandbox = { console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.Flysight;
}

const F = loadFlysight();

const SAMPLE_CSV = `time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,heading,cAcc,gpsFix,numSV
,(deg),(deg),(m),(m/s),(m/s),(m/s),(m),(m),(m/s),(deg),(deg),,
2026-07-25T06:58:00.30Z,47.9038276,2.1750580,1434.659,-11.57,-14.79,10.51,10.956,13.298,0.52,231.95744,1.22441,3,9
2026-07-25T06:58:00.50Z,47.9038061,2.1750169,1432.578,-10.92,-15.44,10.54,7.202,7.508,0.38,234.73104,1.02747,3,9
2026-07-25T06:58:00.80Z,47.9037755,2.1749543,1429.179,-9.87,-16.39,10.66,6.002,6.693,0.28,238.93489,0.89907,3,9
2026-07-25T06:58:00.90Z,47.9037662,2.1749327,1428.035,-9.41,-16.64,10.64,5.537,6.225,0.26,240.51135,0.88636,3,9
2026-07-25T06:58:01.00Z,47.9037574,2.1749108,1426.880,-9.05,-16.80,10.69,5.174,5.843,0.25,241.68641,0.87946,3,9
2026-07-25T06:58:01.10Z,47.9037490,2.1748885,1425.761,-8.73,-17.13,10.75,4.874,5.521,0.24,242.99552,0.86933,3,9
2026-07-25T06:58:01.20Z,47.9037409,2.1748658,1424.643,-8.42,-17.38,10.55,4.623,5.254,0.24,244.15600,0.86734,3,9
2026-07-25T06:58:01.30Z,47.9037331,2.1748427,1423.542,-8.13,-17.53,10.57,4.407,5.020,0.23,245.12732,0.86637,3,9
2026-07-25T06:58:01.40Z,47.9037256,2.1748194,1422.449,-7.81,-17.75,10.48,4.219,4.815,0.23,246.25626,0.86483,3,9
2026-07-25T06:58:01.50Z,47.9037183,2.1747956,1421.357,-7.62,-18.09,10.50,4.054,4.634,0.22,247.15819,0.85530,3,9
2026-07-25T06:58:01.60Z,47.9037112,2.1747715,1420.272,-7.29,-18.25,10.50,3.904,4.470,0.22,248.22259,0.85316,3,9`;

test('parseFlysightCsv reads sample track', () => {
    const { points, error } = F.parseFlysightCsv(SAMPLE_CSV);
    assert.equal(error, undefined);
    assert.equal(points.length, 11);
    assert.equal(points[0].velD, 10.51);
});

test('analyzeFlysightTrack: max speed and altitude above min hMSL', () => {
    const { points } = F.parseFlysightCsv(SAMPLE_CSV);
    const r = F.analyzeFlysightTrack(points, 1);
    assert.equal(r.pointCount, 11);
    assert.ok(r.maxVerticalSpeedKmh > 38 && r.maxVerticalSpeedKmh < 39);
    assert.equal(r.minHmsl, 1420.272);
    assert.ok(r.altitudeM > 4 && r.altitudeM < 8);
});

test('analyzeFlysightTrack: averaging reduces peak vs raw max', () => {
    const { points } = F.parseFlysightCsv(SAMPLE_CSV);
    const raw = F.analyzeFlysightTrack(points, 1);
    const smooth = F.analyzeFlysightTrack(points, 5);
    assert.ok(smooth.maxVerticalSpeedKmh <= raw.maxVerticalSpeedKmh);
});

test('parseFlysightCsv rejects missing columns', () => {
    const r = F.parseFlysightCsv('a,b,c\n1,2,3\n');
    assert.ok(r.error);
    assert.equal(r.points.length, 0);
});

test('medianSampleIntervalSec uses median delta between timestamps', () => {
    const { points } = F.parseFlysightCsv(SAMPLE_CSV);
    const interval = F.medianSampleIntervalSec(points);
    assert.ok(interval > 0.09 && interval < 0.11);
});

test('averagingWindowDurationSec spans n-1 sample intervals', () => {
    assert.equal(F.averagingWindowDurationSec(1, 0.1), null);
    assert.equal(F.averagingWindowDurationSec(2, 0.05), 0.05);
    assert.equal(F.averagingWindowDurationSec(5, 0.1), 0.4);
});

test('formatDurationSec renders compact seconds suffix', () => {
    assert.equal(F.formatDurationSec(0.05), '0.05s');
    assert.equal(F.formatDurationSec(0.4), '0.40s');
});

test('filterPointsByMaxHeight ignores points above AGL ceiling', () => {
    const { points } = F.parseFlysightCsv(SAMPLE_CSV);
    const filtered = F.filterPointsByMaxHeight(points, 10);
    assert.ok(filtered.length < points.length);
    assert.ok(filtered.every(p => p.hMSL <= 1420.272 + 10));
});

test('analyzeFlysightTrack: max height limits eligible points', () => {
    const { points } = F.parseFlysightCsv(SAMPLE_CSV);
    const full = F.analyzeFlysightTrack(points, 1, 500);
    const limited = F.analyzeFlysightTrack(points, 1, 5);
    assert.equal(full.pointCount, points.length);
    assert.ok(limited.pointCount < full.pointCount);
});

test('analyzeFlysightTrack: speed metric selects vertical vs total trajectory speed', () => {
    const { points } = F.parseFlysightCsv(SAMPLE_CSV);
    const vertical = F.analyzeFlysightTrack(points, 1, 500, 'vertical');
    const total = F.analyzeFlysightTrack(points, 1, 500, 'total');
    assert.equal(vertical.speedMetric, 'vertical');
    assert.equal(total.speedMetric, 'total');
    assert.ok(total.maxVerticalSpeedKmh > vertical.maxVerticalSpeedKmh);
    const maxRawTotalKmh = Math.max(...points.map(p => F.trajectorySpeedMs(p))) * 3.6;
    assert.ok(total.maxVerticalSpeedKmh <= maxRawTotalKmh + 0.1);
});

test('analyzeFlysightTrack: both mode returns vertical and total peaks', () => {
    const { points } = F.parseFlysightCsv(SAMPLE_CSV);
    const both = F.analyzeFlysightTrack(points, 1, 500, 'both');
    const vertical = F.analyzeFlysightTrack(points, 1, 500, 'vertical');
    const total = F.analyzeFlysightTrack(points, 1, 500, 'total');
    assert.equal(both.speedMetric, 'both');
    assert.equal(both.maxVerticalSpeedKmh, vertical.maxVerticalSpeedKmh);
    assert.equal(both.maxTotalSpeedKmh, total.maxVerticalSpeedKmh);
    assert.equal(both.time, vertical.time);
    assert.equal(both.totalPeakTime, total.time);
});

test('trajectorySpeedMs is 3D velocity magnitude', () => {
    assert.equal(F.trajectorySpeedMs({ velN: 3, velE: 4, velD: 0 }), 5);
});
