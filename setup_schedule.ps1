$Action = New-ScheduledTaskAction -Execute "node" -Argument "c:\Users\rnath\Documents\PM assistant\daily_agent.js" -WorkingDirectory "c:\Users\rnath\Documents\PM assistant"
$Trigger = New-ScheduledTaskTrigger -Daily -At 8:00AM
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$TaskName = "PM Assistant Daily Report"

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Runs the daily Airtable/Gemini PM agent."
Write-Host "Successfully registered Scheduled Task: $TaskName. It will run every morning at 8:00 AM."
