// Local corrections to the BSData files, applied after download.
// Each entry removes one entry, group or link (by its data id) wherever it appears.
// Saved lists that contain a removed choice simply drop it when opened.

export const CORRECTIONS = [
  {
    remove: '2ee9-187c-a857-f452',
    where: 'Legiones Astartes › Scorpius Missile Tank › Pintle #2 › Combi-bolter',
    note: 'The Scorpius has two Pintle Mounted bolters and may exchange only one of them '
        + 'for a Legion Pintle weapon (done through Pintle #1). Pintle #2 stays a bolter.',
  },
];

export const REMOVED_IDS = new Set(CORRECTIONS.map(c => c.remove));
