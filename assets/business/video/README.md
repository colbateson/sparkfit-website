# SparkFit for Business video

Place the final promotional video here as one or both of:

- `sparkfit-for-business.mp4`
- `sparkfit-for-business.webm`

The reusable component in `business/business.js` checks for these files only when the video section approaches the viewport. When either file exists, it replaces the static product preview with a responsive, non-autoplaying HTML5 video player with accessible controls.

The current static preview is intentional: it is not a fake playable video. The existing AI Coach screenshot is used as the poster/fallback. If captions are produced, add a WebVTT track and attach it in `activateVideo()`.
