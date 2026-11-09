/**
 * Cuts the README's GIFs out of the recordings that capture.ts made. Needs ffmpeg.
 *
 *   npm run capture:gifs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'docs/media';
const RAW = join(OUT, 'raw');
const marks = JSON.parse(readFileSync(join(RAW, 'marks.json'), 'utf8'));

/** Seconds into a recording that a mark happened. */
const at = (recording, name) => Math.max(0, (marks[name] - marks[recording]) / 1000);

/** A palette made for each GIF keeps the painted backgrounds from banding. */
const PALETTE = 'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';

function ffmpeg(args, name) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, join(OUT, name)], { stdio: 'inherit' });
  console.log(`  ${name} ${(statSync(join(OUT, name)).size / 1e6).toFixed(1)} MB`);
}

/** A stretch of one recording, sped up, scaled to this width. */
function clip(recording, from, seconds, { name, width, fps = 12, speed = 1 }) {
  ffmpeg(
    [
      '-ss', String(from), '-t', String(seconds * speed), '-i', join(RAW, `${recording}.webm`),
      '-filter_complex', `setpts=PTS/${speed},fps=${fps},scale=${width}:-1:flags=lanczos,${PALETTE}`,
    ],
    name,
  );
}

// The TV and one phone side by side, from guests joining to the first reveal.
{
  const from = at('phone', 'phone');
  const seconds = at('phone', 'define-end') - from;
  const speed = 4;
  const tvFrom = at('tv', 'phone');
  ffmpeg(
    [
      '-ss', String(tvFrom), '-t', String(seconds), '-i', join(RAW, 'tv.webm'),
      '-ss', String(from), '-t', String(seconds), '-i', join(RAW, 'phone.webm'),
      '-filter_complex',
      [
        `[0:v]setpts=PTS/${speed},fps=7,scale=720:405:flags=lanczos[tv]`,
        `[1:v]setpts=PTS/${speed},fps=7,scale=-2:405:flags=lanczos,pad=iw+24:ih:24:0:color=0x15171c[phone]`,
        `[tv][phone]hstack=inputs=2,pad=iw+48:ih+48:24:24:color=0x15171c,${PALETTE}`,
      ].join(';'),
    ],
    'hero.gif',
  );
}

clip('tv', at('tv', 'geo-reveal'), 8, { name: 'map-reveal.gif', width: 800, fps: 10 });
clip('tv', at('tv', 'podium'), 10, { name: 'podium.gif', width: 720, fps: 10 });
clip('tv', at('tv', 'tips'), 6, { name: 'tips.gif', width: 800, fps: 8 });
