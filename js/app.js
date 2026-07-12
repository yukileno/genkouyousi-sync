import {GenkoYoshi} from "./genkoyoshi.js";
import {Settings} from "./settings.js";
import {SaveHandler} from "./savehandler.js";

// Google Apps Script(GAS)のWebアプリ of のデプロイURLを設定します
// スプレッドシート連携を有効にするには、ここにURLを記述してください。
const GAS_URL = "https://script.google.com/macros/s/AKfycbwczI96EhZiMLuxjxMxmBImYdlv5uJH9iZrGxTlwtRQo1MWN8nNOuo5rt_A2S3QDEDl/exec";

class Main {
    constructor() {
        this.browser = (/(msie|trident|edge|chrome|safari|firefox|opera)/
                .exec(window.navigator.userAgent.toLowerCase()) || ["other"]).pop().replace("trident", "msie");

        this.genko = new GenkoYoshi($(".genko"), 20, 20);
        this.settings = new Settings($("#controlPane"), this);
        this.saveHandler = new SaveHandler(this);
        this.autoSaveTimer = null; // GAS自動保存用タイマー

        $(window).on("unload", this.onClosing.bind(this));
        setInterval(this.onTimerSaving.bind(this), 5 * 60 * 1000);

        this.$pageCss = $("<style>").appendTo($("head"));
        this.$backdrop = null;

        this.studentRoster = null;
        
        this.$loginClassNum = $("#login-class-num").change(this.onClassNumChanged.bind(this));
        this.$loginStudentSelect = $("#login-student-select");
        this.$loginPassword = $("#login-password"); // パスワードフィールド
        this.$teacherCommentBox = $("#teacher-comment-box");
        this.$teacherCommentText = $("#teacher-comment-text");
        this.$teacherMenuBox = $("#teacher-menu-box");
        this.$teacherStudentSelect = $("#teacher-student-select").change(this.onTeacherStudentSelected.bind(this));
        this.$teacherSidebar = $("#teacher-sidebar"); // 教師用児童切り替えサイドバー

        // 児童用「できた！」ボタンのバインド
        this.$completeBtnWrapper = $("#complete-btn-wrapper");
        this.$completeBtn = $("#completeBtn").click(this.onCompleteToggleClicked.bind(this));
        this.isCompletedStatus = false; // できた！（完成）フラグ

        // ログイン要素の初期化
        this.$dialogLogin = $("#dialog-login").modal({show: false, backdrop: 'static', keyboard: false});
        $("#loginForm").submit(this.onLoginSubmitted.bind(this));
        $("#logoutBtn").click(this.onLogoutClicked.bind(this));

        // リアルタイムの文字入力を監視
        $(document).on("input", this.onInputChanged.bind(this));

        // Buttons
        this.$saveBtn = $("#saveBtn").click(this.onSaveClicked.bind(this));
        this.$undoBtn = $("#undoBtn").click(this.onUndoClicked.bind(this));
        this.$redoBtn = $("#redoBtn").click(this.onRedoClicked.bind(this));
        this.$printBtn = $("#printBtn").click(this.onPrintClicked.bind(this));
        this.$fullscreenBtn = $("#fullscreenBtn").click(this.onFullscreenClicked.bind(this));

        // Export text
        this.$exportBtn = $("#export-text").click(this.onExportTextClicked.bind(this));
        this.$dialogExport = $("#dialog-export").modal({show: false});
        this.$dialogExport.find(".btn-okay").click(this.onExportTextConfirmed.bind(this));

        // Copy image to clipboard
        this.$copyImageBtn = $("#copy-image").click(this.onCopyImageClicked.bind(this));

        // Export as image
        this.$exportImageBtn = $("#export-image").click(this.onExportImageClicked.bind(this));
        this.$dialogExportImage = $("#dialog-export-image").modal({show: false});
        this.$dialogExportImage.find("#btn-export-image").click(this.onExportImageConfirmed.bind(this));
        $(".btn-image-export-mode input").change(this.updateExportImageMode.bind(this));

        // Twitter share button
        $("#share-twitter").click(this.onShareTwitterClicked.bind(this));

        // Define drawer action
        this.$drawers = $(".drawer");
        this.$drawers.each((idx, drawer) => {
            $(drawer).find(".drawer-accordion-box").hide();
            $(drawer).find(".drawer-header").click(e => this.onDrawerClicked(e, $(drawer)));
        });

        $(document).on('click touchend', e => {
            if (!$(e.target).closest(".drawer").length) {
                this.$drawers.find(".drawer-accordion-box").hide(200);
                this.$drawers.removeClass("active");
            }
        });
    }

    async setup() {
        // 同期関数であるloadを呼び出します
        this.saveHandler.load();
        
        try {
            // 原稿用紙の初期化（非同期）を待ちます
            await this.genko.init();
            
            this.settings.init();
            this.setPrintPageSize(this.genko.rowSize, this.genko.colSize);
            $('[data-toggle="tooltip"]').tooltip();
            
            // 起動時は共有PCでの安全のため、常にログイン情報をクリアして認証させる
            window.localStorage.removeItem("genko_classNumber");
            window.localStorage.removeItem("genko_studentId");
            window.localStorage.removeItem("genko_studentName");

            // ログイン状態を検証
            await this.checkLoginStatus(); 
        } catch (err) {
            console.error("初期化中にエラーが発生しました:", err);
        }
    }

    onDrawerClicked(e, $drawer) {
        var $accordion = $drawer.find(".drawer-accordion-box");
        var toggle = !$drawer.hasClass("active");

        this.$drawers.find(".drawer-accordion-box").hide(200);
        this.$drawers.removeClass("active");

        if (toggle) {
            $accordion.show(200);
        } else {
            $accordion.hide(200);
        }
        $drawer.toggleClass("active", toggle);
    }

    onUndoClicked() {
        this.genko.undo();
        this.triggerAutoSaveToServer();
    }

    onRedoClicked() {
        this.genko.redo();
        this.triggerAutoSaveToServer();
    }

    setPrintPageSize(rows, cols) {
        if (rows == 20 && cols == 20) {
            // 400字詰
            this.$pageCss.html("@page {size: A4 landscape; margin: 12mm 10mm 5mm 10mm;}")
        } else if (rows == 10 && cols == 20) {
            // 200字詰
            this.$pageCss.html("@page {size: A5 portrait; margin: 15mm 10mm 15mm 10mm;}")
        } else {
            this.$pageCss.html("");
        }
    }

    onSaveClicked() {
        this.saveHandler.save();
    }

    onFullscreenClicked() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    }

    onPrintClicked() {
        window.print();
    }

    onExportTextClicked(e) {
        this.$dialogExport.modal("show");
    }

    onExportTextConfirmed(e) {
        var text = this.genko.getText();
        var link = document.createElement("a");
        var url = URL.createObjectURL(new Blob([text], {type: "text/plain"}));
        link.href = url;
        link.download = this.$dialogExport.find("#export-filename").val();
        //link.dataset.downloadurl = ["text/plain", link.download, link.href].join(":");
        link.click();
        this.$dialogExport.modal("hide");
    }

    onExportImageClicked(e) {
        this.$dialogExportImage.modal("show");
        this.updateExportImageMode();
    }
    
    onExportImageConfirmed(e) {
        const $pages = this.getPages();
        const isSinglePage = $pages.length == 1;
        const isAllInOne = $("#imageExportAllInOne").is(":checked") || isSinglePage;
        const funcExportAsImage = isAllInOne ? this.exportAsImage : this.exportAsImageEachPage;

        this.$dialogExportImage.modal("hide");
        this.startProcessing("backdrop-export-image")
            .then(funcExportAsImage.bind(this))
            .then(this.endProcessing.bind(this));
    }

    updateExportImageMode() {
        const $pages = this.getPages();
        const isSinglePage = $pages.length == 1;
        const isAllInOne = $("#imageExportAllInOne").is(":checked");
        let postfix;

        $(".btn-image-export-mode")
            .toggleClass("disabled", isSinglePage)
            .toggleClass("btn-outline-primary", !isSinglePage)
            .toggleClass("btn-outline-secondary", isSinglePage)
            .attr("inert", isSinglePage ? "inert" : null);

        if (isAllInOne || isSinglePage) {
            postfix = ".png";
            $("#imageFilePagingDesc").hide();
        } else {
            postfix = "-<i>ページ数</i>.png";
            $("#imageFilePagingDesc").show();
        }
        $("#image-filename-postfix").html(postfix);
    }

    exportAsImage() {
        return new Promise((resolve, reject) => {
            $(document).scrollTop(0);
            $("body").css({"padding": "0"});
            $(".genko").css({"padding": "5mm", "margin": "0", "justify-content": "left", "width": "min-content"});
            $(".genko-body").css({"margin": "0"});
            $(".genko-paper").css({"margin": "5mm"});
            $(".genko-paper.blank").hide();
            html2canvas(document.querySelector(".genko"), {
                foreignObjectRendering: this.browser != "safari",
                //useCORS: true,
                //allowTaint: true,
                windowWidth: $(".genko").width(),
                ignoreElements: elem => $(elem).is(".genko-ime, .genko-caret"),
                onclone: (doc) => {
                    $(doc).find(".genko-paper").css({"box-shadow": "none"}).removeClass("newline-visible");
                    $(doc).find(".char-body:has(.fw-space)").html("<div/>");
                    $(doc).find(".char-body:has(.newline), .char-body:has(.hw-space.single)").html("<div/>");
                    $(doc).find(".newline-after").each((idx, e) => {
                        $(e).text($(e).text());
                    });
                    $(doc).find(".hw-space.after").each((idx, e) => {
                        $(e).text($(e).text() + "\xa0");
                    })
                    $(doc).find(".hw-space.before").each((idx, e) => {
                        $(e).text("\xa0" + $(e).text());
                    })
                }
            }).then(canvas => {
                // $("body").append(canvas); // Output image on screen for debugging
                $("body").css({"padding": ""});
                $(".genko").css({"padding": "", "margin": "", "justify-content": "", "width": ""});
                $(".genko-body").css({"margin": ""});
                $(".genko-paper").css({"margin": ""});
                $(".genko-paper.blank").show();
                var link = document.createElement("a");
                var url = canvas.toDataURL();
                var filename = $("#export-image-filename").val() + ".png"
                link.href = url;
                link.download = filename;
                link.click();
                $(() => resolve())
            });
        });
    }

    async exportAsImageEachPage() {
        let $pages = this.getPages();
        $(document).scrollTop(0);
        $("body").css({"padding": "0"});
        $(".genko").css({"padding": "5mm", "margin": "0", "justify-content": "left", "width": "min-content"});
        $(".genko-body").css({"margin": "0"});
        $(".genko-paper").css({"margin": "5mm"});
        $(".genko-paper.blank").hide();
        try {
            for (const [idx, page] of $pages.toArray().entries()) {
                $pages.hide();
                $(page).show();
                const canvas = await html2canvas(document.querySelector(".genko"), {
                    foreignObjectRendering: this.browser != "safari",
                    onclone: (doc) => {
                        $(doc).find(".genko-paper").css({"box-shadow": "none"}).removeClass("newline-visible");
                        $(doc).find(".char-body:has(.fw-space)").html("<div/>");
                        $(doc).find(".char-body:has(.newline), .char-body:has(.hw-space.single)").html("<div/>");
                        $(doc).find(".newline-after").each((idx, e) => {
                            $(e).text($(e).text());
                        });
                        $(doc).find(".hw-space.after").each((idx, e) => {
                            $(e).text($(e).text() + "\xa0");
                        })
                        $(doc).find(".hw-space.before").each((idx, e) => {
                            $(e).text("\xa0" + $(e).text());
                        })
                    }
                });
                var link = document.createElement("a");
                var url = canvas.toDataURL();
                var filename = $("#export-image-filename").val() + `-${(idx + 1).toString().padStart(2, "0")}.png`
                link.href = url;
                link.download = filename;
                link.click();
            }
        } finally {
            $pages.show();
            $("body").css({"padding": ""});
            $(".genko").css({"padding": "", "margin": "", "justify-content": "", "width": ""});
            $(".genko-body").css({"margin": ""});
            $(".genko-paper").css({"margin": ""});
            $(".genko-paper.blank").show();
        }
    }

    onCopyImageClicked(e) {
        this.startProcessing("backdrop-copy-image")
            .then(this.copyAsImage.bind(this))
            .then(this.endProcessing.bind(this))
            .catch(err => {
                this.endProcessing();
                console.error("画像コピーエラー:", err);
                alert("画像のコピー中にエラーが発生しました:\n" + err.message);
            });
    }

    async copyAsImage() {
        let $pages = this.getPages();
        $(document).scrollTop(0);
        $("body").css({"padding": "0"});
        $(".genko").css({"padding": "5mm", "margin": "0", "justify-content": "left", "width": "min-content"});
        $(".genko-body").css({"margin": "0"});
        $(".genko-paper").css({"margin": "5mm"});
        $(".genko-paper.blank").hide();

        try {
            const canvas = await html2canvas(document.querySelector(".genko"), {
                scale: 1.5,
                foreignObjectRendering: this.browser != "safari",
                onclone: (doc) => {
                    $(doc).find(".genko-paper").css({"box-shadow": "none"}).removeClass("newline-visible");
                    $(doc).find(".char-body:has(.fw-space)").html("<div/>");
                    $(doc).find(".char-body:has(.newline), .char-body:has(.hw-space.single)").html("<div/>");
                    $(doc).find(".newline-after").each((idx, e) => {
                        $(e).text($(e).text());
                    });
                    $(doc).find(".hw-space.after").each((idx, e) => {
                        $(e).text($(e).text() + "\xa0");
                    });
                    $(doc).find(".hw-space.before").each((idx, e) => {
                        $(e).text("\xa0" + $(e).text());
                    });
                }
            });

            return new Promise((resolve, reject) => {
                canvas.toBlob(async (blob) => {
                    if (!blob) {
                        reject(new Error("画像の生成に失敗しました。"));
                        return;
                    }
                    if (navigator.clipboard && window.ClipboardItem) {
                        try {
                            const item = new ClipboardItem({ "image/png": blob });
                            await navigator.clipboard.write([item]);
                            alert("原稿用紙の画像をコピーしました！\nロイロノートや別ソフト of の画面で貼り付け（Ctrl + V）して提出してください。");
                            resolve();
                        } catch (clipErr) {
                            reject(clipErr);
                        }
                    } else {
                        reject(new Error("お使いのブラウザが画像のコピー機能に対応していません。"));
                    }
                }, "image/png");
            });
        } finally {
            $pages.show();
            $("body").css({"padding": ""});
            $(".genko").css({"padding": "", "margin": "", "justify-content": "", "width": ""});
            $(".genko-body").css({"margin": ""});
            $(".genko-paper").css({"margin": ""});
            $(".genko-paper.blank").show();
        }
    }

    onShareTwitterClicked(e) {
    }

    setWallpaper(key) {
        $("body").removeClass().addClass("skin-" + key);
    }

    setLightColor(val) {
        var ratio = Math.cos(val * Math.PI / 2 + Math.PI) + 1;
        $(".bg-lighting").css("background-color", `rgb(255, ${184 + 71 * ratio}, ${126 + 129 * ratio})`);
    }

    startProcessing(backdropClass) {
        return new Promise((resolve, reject) => {
            // すでに暗転画面が存在する場合は2重に作成しないように保護
            if (this.$backdrop || $("#processingBackdrop").length > 0) {
                resolve();
                return;
            }
            this.$backdrop = $(`<div id='processingBackdrop' class='modal-backdrop show ${backdropClass}'>`)
                    .appendTo(document.body);
            $(() => resolve());
        });
    }

    endProcessing() {
        setTimeout(() => {
            // DOM上のすべての暗転バックドロップを確実に削除
            const $b = $("#processingBackdrop");
            if ($b.length > 0) {
                $b.fadeOut(500, function() { $(this).remove(); });
            }
            this.$backdrop = null;
        });
    }

    onTimerSaving() {
        this.saveHandler.save();
    }

    onClosing() {
        this.saveHandler.save();
    }

    getPages() {
        return $(".genko-paper:not(.blank)");
    }

    async checkLoginStatus() {
        const classNum = window.localStorage.getItem("genko_classNumber");
        const studentId = window.localStorage.getItem("genko_studentId");
        const studentName = window.localStorage.getItem("genko_studentName");

        if (classNum && studentId && studentName) {
            $("#login-display-class").text(classNum + "組　" + studentId + "番");
            $("#login-display-name").text(studentName);
            
            // 教師用メニューの表示制御 (出席番号「0」を教師用とする)
            if (studentId === "0" || studentId === 0) {
                this.$teacherMenuBox.removeClass("d-none");
                this.$completeBtnWrapper.addClass("d-none"); // 先生用画面ではできた！ボタンは非表示
                // 先生用ワークスペースの初期化（サイドバーの構築）
                await this.initTeacherWorkspace(classNum);
            } else {
                this.$teacherMenuBox.addClass("d-none");
                this.$teacherSidebar.addClass("d-none");
                $("body").removeClass("has-teacher-sidebar");
                this.$completeBtnWrapper.removeClass("d-none"); // 児童用画面ではできた！ボタンを表示
            }
            
            this.$dialogLogin.modal("hide");
        } else {
            $("#login-display-class").text("未ログイン");
            $("#login-display-name").text("ゲスト");
            this.$teacherMenuBox.addClass("d-none");
            this.$teacherSidebar.addClass("d-none");
            $("body").removeClass("has-teacher-sidebar");
            this.$completeBtnWrapper.addClass("d-none"); // 未ログイン時は非表示
            this.$dialogLogin.modal("show");
            // 未ログインの場合、サーバーから児童名簿を読み込む
            await this.loadStudentRoster();
        }
    }

    async onLoginSubmitted(e) {
        e.preventDefault();
        const classNum = this.$loginClassNum.val();
        const studentSelectVal = this.$loginStudentSelect.val(); // 出席番号（studentId）
        
        let password = (this.$loginPassword.val() || "").toString();
        // 児童が全角でパスワードを入力した場合を考慮し、全角英数字を半角に自動変換する
        password = password.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(s) {
            return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
        }).trim();

        if (classNum && studentSelectVal && password) {
            const studentId = studentSelectVal;

            await this.startProcessing("backdrop-loading");
            try {
                const response = await fetch(GAS_URL, {
                    method: "POST",
                    mode: "cors",
                    headers: {
                        "Content-Type": "text/plain"
                    },
                    body: JSON.stringify({
                        action: "login",
                        classNumber: classNum,
                        studentId: studentId,
                        password: password
                    })
                });
                const res = await response.json();
                if (res.status === "success") {
                    const studentName = res.studentName || `${studentId}番`;

                    window.localStorage.setItem("genko_classNumber", classNum);
                    window.localStorage.setItem("genko_studentId", studentId);
                    window.localStorage.setItem("genko_studentName", studentName);
                    $("#login-error").addClass("d-none");
                    await this.checkLoginStatus();

                    // パスワード入力欄をクリア
                    this.$loginPassword.val("");

                    if (studentId === "0" || studentId === 0) {
                        // 先生ログイン時は特に追加の読み込みはなし
                    } else {
                        // 児童ログイン時は通常の個別読み込み
                        if (res.data) {
                            const data = res.data;
                            if (data.settings) {
                                try {
                                    const parsedSettings = JSON.parse(data.settings);
                                    this.settings.apply(parsedSettings.genkoSettings, parsedSettings.appSettings);
                                    
                                    // できた！(完成)ステータスのロードとUI反映
                                    if (parsedSettings.isCompleted !== undefined) {
                                        this.isCompletedStatus = !!parsedSettings.isCompleted;
                                    } else {
                                        this.isCompletedStatus = false;
                                    }
                                    this.updateCompleteButtonUi();
                                } catch (err) {
                                    console.error("設定パースエラー:", err);
                                    this.isCompletedStatus = false;
                                    this.updateCompleteButtonUi();
                                }
                            } else {
                                this.isCompletedStatus = false;
                                this.updateCompleteButtonUi();
                            }

                            if (data.text) {
                                this.genko.setText(data.text);
                            }
                            
                            // 先生からのアドバイスを表示する（一時的に非表示設定）
                            this.$teacherCommentBox.addClass("d-none");
                            if (data.teacherComment && data.teacherComment.trim() !== "") {
                                this.$teacherCommentText.text(data.teacherComment);
                            } else {
                                this.$teacherCommentText.text("アドバイスはまだありません。");
                            }
                            
                            console.log("スプレッドシートからの作文データのロードに成功しました");
                        } else {
                            this.genko.clear();
                            this.isCompletedStatus = false;
                            this.updateCompleteButtonUi();
                            this.$teacherCommentBox.addClass("d-none");
                            this.$teacherCommentText.text("アドバイスはまだありません。");
                            console.log("新規作文の作成を開始します");
                        }

                        this.triggerAutoSaveToServer(true); // ログイン成功時に即座に保存同期
                    }
                } else {
                    $("#login-error").text(res.message || "ログインに失敗しました。").removeClass("d-none");
                }
            } catch (err) {
                console.error("ログイン認証エラー:", err);
                $("#login-error").text("サーバーとの通信に失敗しました。").removeClass("d-none");
            } finally {
                this.endProcessing();
            }
        } else {
            $("#login-error").text("入力項目に誤りがあります。").removeClass("d-none");
        }
    }

    async onLogoutClicked(e) {
        e.preventDefault();
        if (confirm("別の人でログインし直しますか？\n（現在の作文データはそのまま残ります）")) {
            // 教師用サイドバーと余白スタイルを解除
            this.$teacherSidebar.empty().addClass("d-none");
            $("body").removeClass("has-teacher-sidebar");

            window.localStorage.removeItem("genko_classNumber");
            window.localStorage.removeItem("genko_studentId");
            window.localStorage.removeItem("genko_studentName");
            this.$loginClassNum.val("");
            this.$loginStudentSelect.val("").prop("disabled", true);
            this.$loginPassword.val("");
            this.$teacherCommentBox.addClass("d-none");
            this.$teacherCommentText.text("");
            this.$teacherMenuBox.addClass("d-none");
            this.$completeBtnWrapper.addClass("d-none");

            this.$teacherStudentSelect.empty().append(
                $("<option>").val("").text("-- 児童を選択 --").prop("selected", true)
            );
            $(".paper-print-header").remove();

            // エディタをクリア
            this.genko.clear();
            this.isCompletedStatus = false;
            this.updateCompleteButtonUi();

            await this.checkLoginStatus();
        }
    }

    onInputChanged(e) {
        this.triggerAutoSaveToServer();
    }

    triggerAutoSaveToServer(immediate = false) {
        if (this.autoSaveTimer) {
            clearTimeout(this.autoSaveTimer);
        }
        
        const saveAction = async () => {
            const classNum = window.localStorage.getItem("genko_classNumber");
            const studentId = window.localStorage.getItem("genko_studentId");
            const studentName = window.localStorage.getItem("genko_studentName");

            // 教師用アカウントは自分のデータを上書き保存しないように除外
            if (studentId === "0" || studentId === 0) {
                return;
            }

            if (classNum && studentId && studentName) {
                const text = this.genko.getText();
                const charCount = text.length;
                const settingsData = {
                    genkoSettings: {
                        colSize: this.genko.colSize,
                        rowSize: this.genko.rowSize,
                        featuringColor: this.genko.$container.find(".genko-cell").css("border-color"),
                        featuringFont: this.settings.featuringFont
                    },
                    appSettings: {
                        wallpaper: this.settings.wallpaper
                    },
                    isCompleted: this.isCompletedStatus // できた！ステータスをsettingsの一部として保存
                };

                try {
                    const response = await fetch(GAS_URL, {
                        method: "POST",
                        mode: "cors",
                        headers: {
                            "Content-Type": "text/plain"
                        },
                        body: JSON.stringify({
                            action: "save",
                            classNumber: classNum,
                            studentId: studentId,
                            studentName: studentName,
                            charCount: charCount,
                            text: text,
                            settings: JSON.stringify(settingsData)
                        })
                    });
                    const res = await response.json();
                    if (res.status === "success") {
                        console.log("スプレッドシートへの自動保存に成功しました");
                    } else {
                        console.warn("自動保存失敗:", res.message);
                    }
                } catch (err) {
                    console.error("自動保存エラー:", err);
                }
            }
        };

        if (immediate) {
            saveAction();
        } else {
            this.autoSaveTimer = setTimeout(saveAction, 3000); // 通常はタイピング停止後3秒で保存
        }
    }

    async loadStudentRoster() {
        try {
            const response = await fetch(GAS_URL, {
                method: "POST",
                mode: "cors",
                headers: {
                    "Content-Type": "text/plain"
                },
                body: JSON.stringify({
                    action: "get_students"
                })
            });
            const res = await response.json();
            if (res.status === "success") {
                this.studentRoster = res.data;
                
                // クラスセレクトボックスを初期化して充填
                this.$loginClassNum.empty().append(
                    $("<option>").val("").text("クラス（半角数字）を選択してください").prop("disabled", true).prop("selected", true)
                );
                this.$loginStudentSelect.empty().append(
                    $("<option>").val("").text("先にクラスを選択してください").prop("disabled", true).prop("selected", true)
                ).prop("disabled", true);
                
                const classes = Object.keys(this.studentRoster);
                if (classes.length === 0) {
                    $("#login-error").text("名簿データがスプレッドシートに登録されていません。").removeClass("d-none");
                    return;
                }
                
                classes.forEach(c => {
                    this.$loginClassNum.append($("<option>").val(c).text(c));
                });
                $("#login-error").addClass("d-none");
            } else {
                $("#login-error").text("名簿データの取得に失敗しました。").removeClass("d-none");
            }
        } catch (err) {
            console.error("名簿データの取得エラー:", err);
            $("#login-error").text("サーバーとの通信に失敗しました。オフライン状態か、または設定が正しくない可能性があります。").removeClass("d-none");
        }
    }

    onClassNumChanged(e) {
        const selectedClass = this.$loginClassNum.val();
        this.$loginStudentSelect.empty();
        
        if (!selectedClass || !this.studentRoster || !this.studentRoster[selectedClass]) {
            this.$loginStudentSelect.append(
                $("<option>").val("").text("先にクラスを選択してください").prop("disabled", true).prop("selected", true)
            ).prop("disabled", true);
            return;
        }
        
        this.$loginStudentSelect.append(
            $("<option>").val("").text("出席番号を選択してください").prop("disabled", true).prop("selected", true)
        ).prop("disabled", false);
        
        const students = this.studentRoster[selectedClass];
        students.forEach(student => {
            const val = student.id;
            const text = `${student.id}番`;
            this.$loginStudentSelect.append($("<option>").val(val).text(text));
        });
    }

    onTeacherExportPdfClicked(e) {
        e.preventDefault();
    }

    async initTeacherWorkspace(classNum) {
        this.$teacherSidebar.empty().removeClass("d-none");
        $("body").addClass("has-teacher-sidebar");

        await this.startProcessing("backdrop-loading");

        try {
            // 各児童の提出状況（誰が作文を書いているか、完成しているか）を色分けするため、一括ステータスをロード
            const response = await fetch(GAS_URL, {
                method: "POST",
                mode: "cors",
                headers: {
                    "Content-Type": "text/plain"
                },
                body: JSON.stringify({
                    action: "get_all_writings",
                    classNumber: classNum
                })
            });
            const res = await response.json();
            const writings = (res.status === "success" && res.data) ? res.data : [];

            // 設定ドロワー内のセレクトボックスも初期化して充填（補助・同期用）
            this.$teacherStudentSelect.empty().append(
                $("<option>").val("").text("-- 児童を選択 --").prop("selected", true)
            );

            // クラス名簿を取得
            const students = this.studentRoster[classNum] || [];
            students.forEach(s => {
                if (s.id !== 0 && s.id !== "0") {
                    const w = writings.find(item => item.studentId == s.id);
                    const hasWriting = (w && w.text && w.text.trim() !== "");
                    const studentName = (w && w.studentName) ? w.studentName : `${s.id}番`;
                    
                    // できた！(完成)フラグの判定
                    let isCompleted = false;
                    if (w && w.settings) {
                        try {
                            const parsed = JSON.parse(w.settings);
                            isCompleted = !!parsed.isCompleted;
                        } catch(e){}
                    }

                    // 1. 左端の固定サイドバー用丸ボタンの生成
                    const $btn = $("<button>")
                        .addClass("student-btn")
                        .attr("data-student-id", s.id)
                        .attr("title", `${s.id}番 ${studentName}`)
                        .text(s.id)
                        .attr("data-toggle", "tooltip")
                        .attr("data-placement", "right")
                        .click(() => this.selectTeacherStudent(s.id))
                        .appendTo(this.$teacherSidebar);

                    if (hasWriting) {
                        $btn.addClass("has-writing");
                    }
                    if (isCompleted) {
                        $btn.addClass("completed"); // 右上に金色のチェックマークバッジを表示
                    }

                    // 2. セレクトボックス（予備）の充填
                    let statusSuffix = "";
                    if (isCompleted) {
                        statusSuffix = " 〇(できた！)";
                    } else if (hasWriting) {
                        statusSuffix = " 〇(書きかけ)";
                    } else {
                        statusSuffix = " (未入力)";
                    }
                    this.$teacherStudentSelect.append(
                        $("<option>").val(s.id).text(`${s.id}番 ${studentName}${statusSuffix}`)
                    );
                }
            });

            // ツールチップを有効化
            this.$teacherSidebar.find('[data-toggle="tooltip"]').tooltip();

        } catch (err) {
            console.error("先生用サイドバー初期化エラー:", err);
        } finally {
            this.endProcessing();
        }
    }

    onTeacherStudentSelected(e) {
        const studentId = this.$teacherStudentSelect.val();
        this.selectTeacherStudent(studentId);
    }

    async selectTeacherStudent(studentId) {
        // サイドバーボタンのアクティブ表示切替
        this.$teacherSidebar.find(".student-btn").removeClass("active");
        if (studentId) {
            this.$teacherSidebar.find(`.student-btn[data-student-id="${studentId}"]`).addClass("active");
        }

        // ドロワー内のセレクトボックスも同期
        this.$teacherStudentSelect.val(studentId || "");

        $(".paper-print-header").remove(); // 古いヘッダーを削除

        if (!studentId) {
            this.genko.clear();
            return;
        }

        await this.startProcessing("backdrop-loading");

        try {
            const classNum = window.localStorage.getItem("genko_classNumber");
            
            // 指定された児童1人分の「最新」の作文データをGASから直接フェッチ
            const response = await fetch(GAS_URL, {
                method: "POST",
                mode: "cors",
                headers: {
                    "Content-Type": "text/plain"
                },
                body: JSON.stringify({
                    action: "get_student_writing",
                    classNumber: classNum,
                    studentId: studentId
                })
            });
            const res = await response.json();

            if (res.status === "success" && res.data) {
                const w = res.data;
                
                // 設定の適用
                if (w.settings) {
                    try {
                        const parsedSettings = JSON.parse(w.settings);
                        this.settings.apply(parsedSettings.genkoSettings, parsedSettings.appSettings);
                    } catch (err) {
                        console.error("設定適用エラー:", err);
                    }
                } else {
                    this.genko.clear();
                }

                // 作文本文の反映
                this.genko.setText(w.text || "");
                
                // レンダリング完了後、用紙上部に印刷用ヘッダーを埋め込み
                setTimeout(() => {
                    $(".paper-print-header").remove();
                    const $papers = $(".genko-paper");
                    $papers.each(function(p) {
                        const pageNumText = (p + 1) + "/" + $papers.length;
                        const headerText = w.classNumber + "組 " + w.studentId + "番 " + w.studentName + "　" + pageNumText;
                        
                        $("<div>")
                            .addClass("paper-print-header")
                            .text(headerText)
                            .appendTo($(this));
                    });
                }, 300);

                console.log(`${studentId}番の最新作文データを表示しました`);
            } else {
                this.genko.clear();
                alert("この児童の保存された作文データはありません。");
            }
        } catch (err) {
            console.error("児童作文データのロードエラー:", err);
            alert("作文データの取得中にエラーが発生しました。");
        } finally {
            this.endProcessing();
        }
    }

    onCompleteToggleClicked(e) {
        e.preventDefault();
        
        // できた！ステータスをトグル
        this.isCompletedStatus = !this.isCompletedStatus;
        this.updateCompleteButtonUi();

        // 状態変更を即座にサーバー（GAS）へ保存して同期
        this.triggerAutoSaveToServer(true);
    }

    updateCompleteButtonUi() {
        if (this.isCompletedStatus) {
            this.$completeBtn
                .removeClass("status-incomplete")
                .addClass("status-complete")
                .html('<i class="fa fa-check-circle fa-lg mr-1"></i>&nbsp;<strong>できた！(完了)</strong>');
        } else {
            this.$completeBtn
                .removeClass("status-complete")
                .addClass("status-incomplete")
                .html('<i class="fa fa-smile-o fa-lg mr-1"></i>&nbsp;<strong>できた！</strong>');
        }
    }
}

$(() => new Main().setup());
