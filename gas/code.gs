function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // 同時書き込みを防ぐため、10秒間のロックを取得します
    lock.waitLock(10000);
    
    var params = JSON.parse(e.postData.contents);
    var action = params.action;
    
    // スクリプトが紐づいているアクティブなスプレッドシートを動的に取得
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    
    if (action === "get_students") {
      var data = sheet.getDataRange().getValues();
      var students = {};
      
      for (var i = 1; i < data.length; i++) {
        var classNum = normalizeClass(data[i][0]);
        var studentId = data[i][1];
        if (classNum && studentId && studentId !== 0 && studentId !== "0") {
          if (!students[classNum]) {
            students[classNum] = [];
          }
          // 個人情報保護のため、出席番号のみをリストに追加し、氏名は含めない
          students[classNum].push({
            id: studentId
          });
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
      var password = normalizePassword(params.password);
      
      var data = sheet.getDataRange().getValues();
      var studentName = null;
      var authSuccess = false;
      var savedData = null;
      
      // 名簿照合 (A列=クラス, B列=出席番号, C列=氏名, D列=パスワード)
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          studentName = data[i][2] ? data[i][2].toString().trim() : "";
          var dbPassword = normalizePassword(data[i][3]);
          if (dbPassword === password) {
            authSuccess = true;
            // ログイン成功と同時に、同じ行 of のG列(本文)とH列(設定)からデータを取得してロードする
            savedData = {
              classNumber: data[i][0],
              studentId: data[i][1],
              studentName: studentName,
              charCount: data[i][5] || 0,
              text: data[i][6] || "",
              settings: data[i][7] || null,
              teacherComment: data[i][8] || ""
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
      
    } else if (action === "save") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      var studentName = params.studentName;
      var charCount = params.charCount;
      var text = params.text;
      var settings = params.settings;
      
      var data = sheet.getDataRange().getValues();
      var rowIdx = -1;
      
      // 既存レコード of の更新先を探索
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          rowIdx = i + 1;
          break;
        }
      }
      
      if (rowIdx === -1) {
        // 新規追加 (A=クラス, B=出席番号, C=氏名, D=パスワード(空), E=更新日時, F=文字数, G=本文, H=設定)
        sheet.appendRow([classNumber, studentId, studentName, "", new Date(), charCount, text, settings]);
      } else {
        // 更新
        sheet.getRange(rowIdx, 3).setValue(studentName);
        sheet.getRange(rowIdx, 5).setValue(new Date());
        sheet.getRange(rowIdx, 6).setValue(charCount);
        sheet.getRange(rowIdx, 7).setValue(text);
        sheet.getRange(rowIdx, 8).setValue(settings);
      }
      
      return ContentService.createTextOutput(JSON.stringify({ status: "success" }))
        .setMimeType(ContentService.MimeType.JSON);
        
    } else if (action === "get_all_writings") {
      var classNumber = normalizeClass(params.classNumber);
      var data = sheet.getDataRange().getValues();
      var writings = [];
      
      for (var i = 1; i < data.length; i++) {
        var classNum = normalizeClass(data[i][0]);
        var studentId = data[i][1];
        
        // 指定されたクラスで、かつ出席番号が0以外の児童 of のデータを全件取得
        if (classNum == classNumber && studentId !== null && studentId !== 0) {
          writings.push({
            classNumber: data[i][0],
            studentId: data[i][1],
            studentName: data[i][2] ? data[i][2].toString().trim() : "",
            charCount: data[i][5] || 0,
            text: data[i][6] || "",
            settings: data[i][7] || null
          });
        }
      }
      
      return ContentService.createTextOutput(JSON.stringify({ status: "success", data: writings }))
        .setMimeType(ContentService.MimeType.JSON);
        
    } else if (action === "get_student_writing") {
      var classNumber = normalizeClass(params.classNumber);
      var studentId = params.studentId;
      
      var data = sheet.getDataRange().getValues();
      var studentName = null;
      var savedData = null;
      
      for (var i = 1; i < data.length; i++) {
        if (normalizeClass(data[i][0]) == classNumber && data[i][1] == studentId) {
          studentName = data[i][2] ? data[i][2].toString().trim() : "";
          savedData = {
            classNumber: data[i][0],
            studentId: data[i][1],
            studentName: studentName,
            charCount: data[i][5] || 0,
            text: data[i][6] || "",
            settings: data[i][7] || null,
            teacherComment: data[i][8] || ""
          };
          break;
        }
      }
      
      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", 
        studentName: studentName,
        data: savedData 
      })).setMimeType(ContentService.MimeType.JSON);
    }
  } catch(error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    // 処理完了後、ロックを解放します
    lock.releaseLock();
  }
}

function normalizeClass(classStr) {
  if (classStr === undefined || classStr === null || classStr === "") return "";
  return classStr.toString().trim()
    .replace(/[０-９]/g, function(s) {
      return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    })
    .replace(/[^0-9]/g, "");
}

function normalizePassword(passStr) {
  if (passStr === undefined || passStr === null) return "";
  return passStr.toString().trim()
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function(s) {
      return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    });
}
