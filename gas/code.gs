function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var action = params.action || "save";
    
    if (action === "save") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      var charCount = params.charCount;
      var text = params.text;
      var settings = params.settings;
      var isCompleted = (params.isCompleted === true || params.isCompleted === "true");
      var timestamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm");
      
      var sheet = getTargetSheet(classNumber);
      var data = sheet.getDataRange().getValues();
      var foundRow = -1;
      
      // 登録されている児童の行を検索 (A列=クラス, B列=出席番号)
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          foundRow = i + 1; // 1-based index
          break;
        }
      }
      
      if (foundRow > 0) {
        // 同じ行の右側に作文データを上書き保存
        sheet.getRange(foundRow, 5).setValue(timestamp); // E列: 保存日時
        sheet.getRange(foundRow, 6).setValue(charCount); // F列: 文字数
        sheet.getRange(foundRow, 7).setValue(text);      // G列: 本文
        
        // 教師(99番)の場合のみH列(設定データ)を保存する
        if (studentId == 99 || studentId == "99") {
          sheet.getRange(foundRow, 8).setValue(settings);  // H列: 設定
        }
        
        // 児童用のできた！(完了)ステータスは J列（10列目）に書き込む
        if (studentId != 99 && studentId != "99") {
          sheet.getRange(foundRow, 10).setValue(isCompleted ? "できた" : "");
        }
        
        return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
          .setMimeType(ContentService.MimeType.JSON);
      } else {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "児童が名簿に登録されていません" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
    } else if (action === "load") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      
      var sheet = getTargetSheet(classNumber);
      var data = sheet.getDataRange().getValues();
      var result = null;
      
      // クラスの教師(99番)の設定データを取得
      var teacherSettings = null;
      for (var j = 1; j < data.length; j++) {
        if (normalizeClass(data[j][0]) == classNumber && (data[j][1] == 99 || data[j][1] == "99")) {
          teacherSettings = data[j][7] || null;
          break;
        }
      }
      
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          var isCompletedVal = data[i][9] === "できた"; // J列 (0-indexedで9)
          var finalSettings = null;
          if (teacherSettings) {
            try {
              var parsed = JSON.parse(teacherSettings);
              parsed.isCompleted = isCompletedVal;
              finalSettings = JSON.stringify(parsed);
            } catch(e) {
              finalSettings = JSON.stringify({ isCompleted: isCompletedVal });
            }
          } else {
            finalSettings = JSON.stringify({ isCompleted: isCompletedVal });
          }

          result = {
            classNumber: data[i][0],
            studentId: data[i][1],
            studentName: data[i][2],
            charCount: data[i][5] || 0,
            text: data[i][6] || "",
            settings: finalSettings, // 教師設定に「できた」状態をマージして返す
            teacherComment: data[i][8] ? data[i][8].toString().trim() : "" // I列: 先生のアドバイス
          };
          break;
        }
      }
      
      if (result) {
        return ContentService.createTextOutput(JSON.stringify({ status: "success", data: result }))
          .setMimeType(ContentService.MimeType.JSON);
      } else {
        return ContentService.createTextOutput(JSON.stringify({ status: "not_found" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
    } else if (action === "get_students") {
      var masterSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      var settingsSheet = masterSpreadsheet.getSheetByName("クラス設定");
      var students = {};
      var sheetsToProcess = [];
      
      if (settingsSheet) {
        var settingsData = settingsSheet.getDataRange().getValues();
        // 1行目はヘッダー [クラス, スプレッドシートID, URL]
        for (var i = 1; i < settingsData.length; i++) {
          var cNum = normalizeClass(settingsData[i][0]);
          var sId = settingsData[i][1] ? settingsData[i][1].toString().trim() : "";
          if (cNum && sId) {
            sheetsToProcess.push({ classNum: cNum, sheetId: sId });
          }
        }
      }
      
      // クラス設定がない場合、または何も登録されていない場合は、マスタースプレッドシート自身の「名簿」から取得
      if (sheetsToProcess.length === 0) {
        var defaultSheet = masterSpreadsheet.getSheetByName("名簿") || masterSpreadsheet.getActiveSheet();
        processSheet(defaultSheet, students);
      } else {
        // 各クラスのスプレッドシートから名簿を取得
        for (var k = 0; k < sheetsToProcess.length; k++) {
          try {
            var targetSheet = SpreadsheetApp.openById(sheetsToProcess[k].sheetId).getSheetByName("名簿")
                              || SpreadsheetApp.openById(sheetsToProcess[k].sheetId).getActiveSheet();
            processSheet(targetSheet, students);
          } catch(err) {
            Logger.log("Error loading roster from sheet: " + sheetsToProcess[k].sheetId + ". Error: " + err.toString());
          }
        }
      }
      
      // 出席番号順にソート
      for (var classNum in students) {
        students[classNum].sort(function(a, b) {
          return a.id - b.id;
        });
      }
      
      return ContentService.createTextOutput(JSON.stringify({ status: "success", data: students }))
        .setMimeType(ContentService.MimeType.JSON);
        
    } else if (action === "login") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      var password = params.password ? params.password.toString().trim() : "";
      
      var sheet = getTargetSheet(classNumber);
      var data = sheet.getDataRange().getValues();
      var studentName = null;
      var authSuccess = false;
      var savedData = null;
      
      // 名簿照合 (A列=クラス, B列=出席番号, C列=氏名, D列=パスワード)
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          studentName = data[i][2] ? data[i][2].toString().trim() : "";
          var dbPassword = data[i][3] ? data[i][3].toString().trim() : "";
          if (dbPassword === password) {
            authSuccess = true;
            
            // クラスの教師(99番)の設定データを取得
            var teacherSettings = null;
            for (var j = 1; j < data.length; j++) {
              if (normalizeClass(data[j][0]) == classNumber && (data[j][1] == 99 || data[j][1] == "99")) {
                teacherSettings = data[j][7] || null;
                break;
              }
            }

            var isCompletedVal = data[i][9] === "できた"; // J列
            var finalSettings = null;
            if (teacherSettings) {
              try {
                var parsed = JSON.parse(teacherSettings);
                parsed.isCompleted = isCompletedVal;
                finalSettings = JSON.stringify(parsed);
              } catch(e) {
                finalSettings = JSON.stringify({ isCompleted: isCompletedVal });
              }
            } else {
              finalSettings = JSON.stringify({ isCompleted: isCompletedVal });
            }

            // ログイン成功と同時に、同じ行のG列(本文)、I列(アドバイス)からデータを取得してロードする
            savedData = {
              classNumber: data[i][0],
              studentId: data[i][1],
              studentName: studentName,
              charCount: data[i][5] || 0,
              text: data[i][6] || "",
              settings: finalSettings,
              teacherComment: data[i][8] ? data[i][8].toString().trim() : "" // I列: 先生のアドバイス
            };
          }
          break;
        }
      }
      
      if (!studentName) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "該当する児童が見つかりません" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
      if (!authSuccess) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "パスワードが正しくありません" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", 
        studentName: studentName,
        data: savedData
      })).setMimeType(ContentService.MimeType.JSON);

    } else if (action === "get_all_writings") {
      var classNumber = normalizeClass(params.classNumber);
      var sheet = getTargetSheet(classNumber);
      var data = sheet.getDataRange().getValues();
      var writings = [];
      
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber) {
          var isCompletedVal = data[i][9] === "できた"; // J列
          
          writings.push({
            studentId: data[i][1],
            studentName: data[i][2] ? data[i][2].toString().trim() : "",
            charCount: data[i][5] || 0,
            text: data[i][6] || "",
            settings: JSON.stringify({ isCompleted: isCompletedVal })
          });
        }
      }
      
      return ContentService.createTextOutput(JSON.stringify({ status: "success", data: writings }))
        .setMimeType(ContentService.MimeType.JSON);

    } else if (action === "get_student_writing") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      var sheet = getTargetSheet(classNumber);
      var data = sheet.getDataRange().getValues();
      var result = null;
      
      // クラスの教師(99番)の設定データを取得
      var teacherSettings = null;
      for (var j = 1; j < data.length; j++) {
        if (normalizeClass(data[j][0]) == classNumber && (data[j][1] == 99 || data[j][1] == "99")) {
          teacherSettings = data[j][7] || null;
          break;
        }
      }

      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          var isCompletedVal = data[i][9] === "できた"; // J列
          var finalSettings = null;
          if (teacherSettings) {
            try {
              var parsed = JSON.parse(teacherSettings);
              parsed.isCompleted = isCompletedVal;
              finalSettings = JSON.stringify(parsed);
            } catch(e) {
              finalSettings = JSON.stringify({ isCompleted: isCompletedVal });
            }
          } else {
            finalSettings = JSON.stringify({ isCompleted: isCompletedVal });
          }

          result = {
            classNumber: data[i][0],
            studentId: data[i][1],
            studentName: data[i][2],
            charCount: data[i][5] || 0,
            text: data[i][6] || "",
            settings: finalSettings,
            teacherComment: data[i][8] ? data[i][8].toString().trim() : "" // I列: 先生のアドバイス
          };
          break;
        }
      }
      
      if (result) {
        return ContentService.createTextOutput(JSON.stringify({ status: "success", data: result }))
          .setMimeType(ContentService.MimeType.JSON);
      } else {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "データが見つかりません" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
  } catch(error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getTargetSheet(classNumber) {
  var masterSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var settingsSheet = masterSpreadsheet.getSheetByName("クラス設定");
  if (!settingsSheet) {
    // クラス設定シートがない場合は、マスタースプレッドシートの「名簿」または最初のアクティブシートを返す
    return masterSpreadsheet.getSheetByName("名簿") || masterSpreadsheet.getActiveSheet();
  }
  
  var data = settingsSheet.getDataRange().getValues();
  var sheetId = "";
  
  // 1行目はヘッダー [クラス, スプレッドシートID, URL]
  for (var i = 1; i < data.length; i++) {
    if (normalizeClass(data[i][0]) == normalizeClass(classNumber)) {
      sheetId = data[i][1] ? data[i][1].toString().trim() : "";
      break;
    }
  }
  
  if (sheetId) {
    try {
      var targetSpreadsheet = SpreadsheetApp.openById(sheetId);
      var sheet = targetSpreadsheet.getSheetByName("名簿") || targetSpreadsheet.getActiveSheet();
      // もしシートが完全に空の場合は、初期ヘッダーを設定する（安全策）
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(["クラス", "出席番号", "氏名", "パスワード", "最終保存日時", "文字数", "本文", "設定データ", "先生のアドバイス", "できたフラグ"]);
      }
      return sheet;
    } catch(err) {
      Logger.log("Error opening spreadsheet by ID: " + sheetId + ". Error: " + err.toString());
    }
  }
  
  // フォールバック
  var defaultSheet = masterSpreadsheet.getSheetByName("名簿") || masterSpreadsheet.getActiveSheet();
  if (defaultSheet.getLastRow() === 0) {
    defaultSheet.appendRow(["クラス", "出席番号", "氏名", "パスワード", "最終保存日時", "文字数", "本文", "設定データ", "先生のアドバイス", "できたフラグ"]);
  }
  return defaultSheet;
}

function processSheet(sheet, students) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var classNum = normalizeClass(data[i][0]);
    var studentId = data[i][1] ? parseInt(data[i][1]) : null;
    
    if (!classNum || !studentId) continue;
    
    if (!students[classNum]) {
      students[classNum] = [];
    }
    
    students[classNum].push({
      id: studentId,
      name: data[i][2] ? data[i][2].toString().trim() : ""
    });
  }
}

function normalizeClass(classStr) {
  if (!classStr) return "";
  return classStr.toString().trim()
    .replace(/[０-９]/g, function(s) {
      return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    })
    .replace(/[^0-9]/g, "");
}
