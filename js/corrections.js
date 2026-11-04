// Local corrections to the BSData files, applied after download.
// Each entry either removes one entry, group or link (by its data id) wherever it
// appears, or renames one (fixing a typo in the data).
// Saved lists that contain a removed choice simply drop it when opened.

export const CORRECTIONS = [
  {
    remove: '2ee9-187c-a857-f452',
    where: 'Legiones Astartes › Scorpius Missile Tank › Pintle #2 › Combi-bolter',
    note: 'The Scorpius has two Pintle Mounted bolters and may exchange only one of them '
        + 'for a Legion Pintle weapon (done through Pintle #1). Pintle #2 stays a bolter.',
  },
  {
    rename: '11d4-9ceb-1ff7-db2b', name: 'Laspistol and charnabal sabre',
    where: 'Solar Auxilia › Exalted Section › Depravor › Options',
    note: 'Typo: "Charnible Sabre".',
  },
  {
    rename: '3c29-b4c7-af3f-8b2b', name: 'Laspistol and charnabal sabre',
    where: 'Solar Auxilia › Exalted Section › Options',
    note: 'Typo: "Charnible Sabre".',
  },
];

export const REMOVED_IDS = new Set(CORRECTIONS.filter(c => c.remove).map(c => c.remove));
export const RENAMES = new Map(CORRECTIONS.filter(c => c.rename).map(c => [c.rename, c.name]));
