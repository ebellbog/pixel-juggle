const PALETTE = [
    '#e6194b',
    '#3cb44b',
    '#4363d8',
    '#f58231',
    '#911eb4',
    '#42d4f4',
    '#f032e6',
    '#bfef45',
    '#fabed4',
    '#469990',
];

export default class Ball {
    constructor(id) {
        this.id = id;
        this.color = PALETTE[id % PALETTE.length];
    }
}
