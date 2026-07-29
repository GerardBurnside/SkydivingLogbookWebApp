/**
 * Flysight GNSS track CSV parsing and max vertical speed analysis.
 */
(function (global) {
    'use strict';

    const REQUIRED_COLUMNS = ['time', 'hMSL', 'velD'];

    /**
     * @param {string} line
     * @returns {string[]}
     */
    function splitCsvLine(line) {
        return line.split(',');
    }

    /**
     * @param {string} headerLine
     * @returns {Map<string, number>}
     */
    function parseHeaderIndices(headerLine) {
        const cols = splitCsvLine(headerLine.trim());
        const map = new Map();
        cols.forEach((name, i) => {
            const key = name.trim();
            if (key) map.set(key, i);
        });
        return map;
    }

    /**
     * @param {string} text
     * @returns {{ points: { time: string, hMSL: number, velD: number }[], error?: string }}
     */
    function parseFlysightCsv(text) {
        const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() !== '');
        if (lines.length < 2) {
            return { points: [], error: 'File is empty or too short.' };
        }

        let headerIdx = -1;
        let colMap = null;
        for (let i = 0; i < lines.length; i++) {
            const map = parseHeaderIndices(lines[i]);
            if (REQUIRED_COLUMNS.every(c => map.has(c))) {
                headerIdx = i;
                colMap = map;
                break;
            }
        }

        if (!colMap) {
            return { points: [], error: 'Missing required columns (time, hMSL, velD).' };
        }

        const timeCol = colMap.get('time');
        const hmslCol = colMap.get('hMSL');
        const velDCol = colMap.get('velD');
        const points = [];

        for (let i = headerIdx + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const first = line.split(',')[0].trim();
            if (!first || first.startsWith('(')) continue;

            const cols = splitCsvLine(line);
            const time = cols[timeCol]?.trim();
            const hMSL = parseFloat(cols[hmslCol]);
            const velD = parseFloat(cols[velDCol]);
            if (!time || !Number.isFinite(hMSL) || !Number.isFinite(velD)) continue;

            points.push({ time, hMSL, velD });
        }

        if (points.length === 0) {
            return { points: [], error: 'No valid track points found.' };
        }

        return { points };
    }

    /** Typical Flysight log interval (10 Hz) when no track is loaded. */
    const DEFAULT_SAMPLE_INTERVAL_SEC = 0.1;

    /**
     * @param {{ time: string }[]} points
     * @returns {number}
     */
    function medianSampleIntervalSec(points) {
        if (points.length < 2) return DEFAULT_SAMPLE_INTERVAL_SEC;

        const deltas = [];
        for (let i = 1; i < points.length; i++) {
            const t0 = Date.parse(points[i - 1].time);
            const t1 = Date.parse(points[i].time);
            if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
            const dt = (t1 - t0) / 1000;
            if (dt > 0) deltas.push(dt);
        }

        if (!deltas.length) return DEFAULT_SAMPLE_INTERVAL_SEC;

        deltas.sort((a, b) => a - b);
        const mid = Math.floor(deltas.length / 2);
        return deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
    }

    /**
     * @param {number} avgPoints
     * @param {number} sampleIntervalSec
     * @returns {number|null}
     */
    function averagingWindowDurationSec(avgPoints, sampleIntervalSec) {
        const n = Math.max(1, Math.min(20, Math.floor(avgPoints) || 1));
        if (n <= 1 || !Number.isFinite(sampleIntervalSec) || sampleIntervalSec <= 0) return null;
        return (n - 1) * sampleIntervalSec;
    }

    /**
     * @param {number} sec
     * @returns {string}
     */
    function formatDurationSec(sec) {
        if (!Number.isFinite(sec) || sec <= 0) return '';
        if (sec < 0.01) return `${sec.toFixed(3)}s`;
        if (sec < 1) return `${sec.toFixed(2)}s`;
        if (sec < 10) return `${sec.toFixed(1)}s`;
        return `${Math.round(sec)}s`;
    }

    /**
     * Centered moving average; window shrinks near edges.
     * @param {number[]} values
     * @param {number} windowSize
     * @returns {number[]}
     */
    function movingAverage(values, windowSize) {
        const n = Math.max(1, Math.min(20, Math.floor(windowSize) || 1));
        if (values.length === 0) return [];
        const out = new Array(values.length);
        const half = Math.floor(n / 2);

        for (let i = 0; i < values.length; i++) {
            let start = Math.max(0, i - half);
            let end = Math.min(values.length, start + n);
            start = Math.max(0, end - n);
            let sum = 0;
            for (let j = start; j < end; j++) sum += values[j];
            out[i] = sum / (end - start);
        }
        return out;
    }

    /**
     * @param {{ hMSL: number, velD: number }[]} points
     * @param {number} avgPoints
     * @returns {{
     *   maxVerticalSpeedKmh: number,
     *   altitudeM: number,
     *   time: string,
     *   pointCount: number,
     *   minHmsl: number,
     *   error?: string
     * }}
     */
    function analyzeFlysightTrack(points, avgPoints = 1) {
        if (!points.length) {
            return {
                maxVerticalSpeedKmh: 0,
                altitudeM: 0,
                time: '',
                pointCount: 0,
                minHmsl: 0,
                error: 'No track points.'
            };
        }

        const windowSize = Math.max(1, Math.min(20, Math.floor(avgPoints) || 1));
        const absVelD = points.map(p => Math.abs(p.velD));
        const smoothedVel = movingAverage(absVelD, windowSize);
        const smoothedAlt = movingAverage(points.map(p => p.hMSL), windowSize);

        let peakIdx = 0;
        for (let i = 1; i < smoothedVel.length; i++) {
            if (smoothedVel[i] > smoothedVel[peakIdx]) peakIdx = i;
        }

        const minHmsl = points.reduce((min, p) => (p.hMSL < min ? p.hMSL : min), points[0].hMSL);
        const altitudeM = Math.max(0, smoothedAlt[peakIdx] - minHmsl);
        const maxVerticalSpeedKmh = smoothedVel[peakIdx] * 3.6;

        return {
            maxVerticalSpeedKmh,
            altitudeM,
            time: points[peakIdx].time,
            pointCount: points.length,
            minHmsl
        };
    }

    /**
     * @param {string} text
     * @param {number} avgPoints
     * @returns {ReturnType<typeof analyzeFlysightTrack> & { points: typeof points }}
     */
    function analyzeFlysightCsv(text, avgPoints = 1) {
        const parsed = parseFlysightCsv(text);
        if (parsed.error) {
            return {
                points: [],
                maxVerticalSpeedKmh: 0,
                altitudeM: 0,
                time: '',
                pointCount: 0,
                minHmsl: 0,
                error: parsed.error
            };
        }
        const result = analyzeFlysightTrack(parsed.points, avgPoints);
        return { ...result, points: parsed.points };
    }

    const Flysight = {
        parseFlysightCsv,
        analyzeFlysightTrack,
        analyzeFlysightCsv,
        movingAverage,
        medianSampleIntervalSec,
        averagingWindowDurationSec,
        formatDurationSec,
        DEFAULT_SAMPLE_INTERVAL_SEC
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Flysight;
    } else {
        global.Flysight = Flysight;
    }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : global);
