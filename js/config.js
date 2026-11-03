// Where the data comes from. The app reads the BSData files straight from
// GitHub at one fixed commit, so the rules never change under you.
export const DATA_REPO = 'BSData/horus-heresy-3rd-edition';
export const DATA_COMMIT = '5166ba2b10a7b18b1757186191a57a900050e628';
export const DATA_DATE = '2026-11-03';
export const GAME_SYSTEM_FILE = 'Horus Heresy 3rd Edition.json';

export function dataUrl(file) {
  return `https://raw.githubusercontent.com/${DATA_REPO}/${DATA_COMMIT}/${encodeURIComponent(file)}`;
}

export const POINTS_ID = '9893-c379-920b-8982';
export const DEFAULT_POINTS = 3000;
