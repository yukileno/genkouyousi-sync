import { GenkoYoshi } from "./genkoyoshi.js";

export class SaveHandler {

    /**
     * @param {Main} main 
     */
    constructor(main) {
        /** @type {GenkoYoshi} */
        this.genko = main.genko;
        /** @type {Object} */
        this.settings = main.settings.params;
    }

    save() {
        // スプレッドシート連携時の競合防止のため、ローカル（ブラウザ）への保存は一切行いません
    }

    load() {
        // スプレッドシート連携時の競合防止のため、ローカル（ブラウザ）からの読み込みは一切行いません
    }
}

// For old Safari, static class fields define outside the class
SaveHandler.STORAGE_KEY = "genkoyoshi";
