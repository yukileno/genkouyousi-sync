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
        // 教師用アカウントまたは未ログイン時はローカルストレージへの書き込みをガード
        const studentId = window.localStorage.getItem("genko_studentId");
        if (studentId === "0" || studentId === 0) {
            return;
        }

        var data = {
            rev: 2,
            genkoSettings: {
                colSize: this.genko.colSize,
                rowSize: this.genko.rowSize,
                featuringColor: this.genko.featuringColor,
                featuringFont: this.genko.featuringFont,
                featuringFontRoman: this.genko.featuringFontRoman,
                cellOptions: this.genko.cellOptions,
                selectionStyle: this.genko.selectionStyle,
            },
            genkoText: this.genko.text.getText().toString(),
            appSettings: {
                wallpaper: this.settings.wallpaper,
                lightColor: this.settings.lightColor
            }
        }

        window.localStorage.setItem(SaveHandler.STORAGE_KEY, JSON.stringify(data));
    }

    load() {
        // ログイン状態であれば、起動時の古いローカル一時保存からのロードをスキップ（スプレッドシートを正本とする）
        const studentId = window.localStorage.getItem("genko_studentId");
        if (studentId) {
            return;
        }

        var data = JSON.parse(window.localStorage.getItem(SaveHandler.STORAGE_KEY));
        if (!data) return;
        this.genko.setOptions(data.genkoSettings);
        this.genko.setText(data.genkoText);
        $.extend(this.settings, data.appSettings);
    }
}

// For old Safari, static class fields define outside the class
SaveHandler.STORAGE_KEY = "genkoyoshi";
