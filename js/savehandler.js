import { GenkoYoshi } from "./genkoyoshi.js";

export class SaveHandler {

    /**
     * @param {Main} main 
     */
    constructor(main) {
        this.main = main;
        /** @type {GenkoYoshi} */
        this.genko = main.genko;
        /** @type {Object} */
        this.settings = main.settings.params;
        
        this.gasUrl = "https://script.google.com/macros/s/AKfycbwczI96EhZiMLuxjxMxmBImYdlv5uJH9iZrGxTlwtRQo1MWN8nNOuo5rt_A2S3QDEDl/exec";
        this.currentUser = null;
        this.isTeacher = false;
        this.currentViewingStudent = null;
    }

    async save() {
        if (!this.currentUser) return;
        const targetUser = this.isTeacher ? this.currentViewingStudent : this.currentUser;
        if (!targetUser) return; // 教師モードで児童未選択時は保存しない

        const genkoTextStr = this.genko.text.getText().toString();
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
            genkoText: genkoTextStr,
            appSettings: {
                wallpaper: this.settings.wallpaper,
                lightColor: this.settings.lightColor
            }
        }

        try {
            await fetch(this.gasUrl, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify({
                    action: "save",
                    attendanceNumber: targetUser,
                    characterCount: genkoTextStr.length,
                    data: data
                })
            });
            console.log("Saved to GAS successfully.");
        } catch (e) {
            console.error("Save to GAS failed", e);
        }
    }

    async load(userId = null) {
        const targetUser = userId || (this.isTeacher ? this.currentViewingStudent : this.currentUser);
        if (!targetUser) return false;

        try {
            const res = await fetch(`${this.gasUrl}?action=load&attendanceNumber=${encodeURIComponent(targetUser)}`);
            if (!res.ok) throw new Error("Network response was not ok");
            const responseData = await res.json();
            
            if (responseData && responseData.data) {
                var data = responseData.data;
                this.genko.setOptions(data.genkoSettings);
                this.genko.setText(data.genkoText);
                $.extend(this.settings, data.appSettings);
                this.main.settings.applySettings(); // 設定反映
                this.main.genko.render();
                return true;
            } else {
                // データなし
                this.genko.setText("");
                this.main.genko.render();
                return true; 
            }
        } catch (e) {
            console.error("Load from GAS failed", e);
            // エラー時はローカルの初期状態にする
            this.genko.setText("");
            this.main.genko.render();
            return false;
        }
    }

    async login(attendanceNumber, password) {
        try {
            const res = await fetch(`${this.gasUrl}?action=login&attendanceNumber=${encodeURIComponent(attendanceNumber)}&password=${encodeURIComponent(password)}`);
            const data = await res.json();
            
            if (data.success) {
                this.currentUser = attendanceNumber;
                this.isTeacher = (attendanceNumber == 0 || attendanceNumber == "0");
                return { success: true, isTeacher: this.isTeacher, studentName: data.studentName };
            } else {
                return { success: false, message: data.message || "ログインに失敗しました。" };
            }
        } catch (e) {
            console.warn("GAS Login failed, using fallback logic for testing", e);
            if (attendanceNumber == "0") {
                this.currentUser = "0";
                this.isTeacher = true;
                return { success: true, isTeacher: true };
            } else if (attendanceNumber) {
                this.currentUser = attendanceNumber;
                this.isTeacher = false;
                return { success: true, isTeacher: false, studentName: "モック児童" + attendanceNumber };
            }
            return { success: false, message: "出席番号を入力してください。" };
        }
    }

    async getStudents() {
        try {
            const res = await fetch(`${this.gasUrl}?action=list_students`);
            const data = await res.json();
            if (data.success && data.students) {
                return data.students; 
            }
            return [];
        } catch(e) {
            console.warn("GAS getStudents failed, returning mock data", e);
            return [
                { attendanceNumber: 1, name: "あああ" },
                { attendanceNumber: 2, name: "わたなべ" },
                { attendanceNumber: 3, name: "いいい" },
            ]; // モックデータ
        }
    }

    logout() {
        this.save(); // ログアウト前に一応保存
        this.currentUser = null;
        this.isTeacher = false;
        this.currentViewingStudent = null;
        this.genko.setText("");
        this.main.genko.render();
    }
}
