# SparkFit for Business video

The live promotional video assets are:

- `sparkfit-for-business.mp4`: 29.7 seconds, 960 x 768, H.264 video with AAC audio
- `sparkfit-for-business-poster.jpg`: branded poster frame displayed before playback

The source CapCut export was a 1080 x 1920 portrait video containing a landscape programme and burned-in captions. The website version uses a 5:4 crop that removes the unused portrait space while retaining the complete programme, captions and closing call to action.

The MP4 is compressed for web delivery and has its metadata at the start of the file for faster playback. The reusable component in `business/business.js` checks for the file only when the video section approaches the viewport. It then replaces the static product preview with a responsive HTML5 video player. The video autoplays muted and inline, loops, includes accessible controls and only begins loading when the section approaches the viewport.
