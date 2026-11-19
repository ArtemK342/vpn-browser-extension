# Рисует иконки расширения: icons\on-*.png (салатовый [f]) и off-*.png (серый). Запуск: powershell -File make_icons.ps1
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $PSScriptRoot '..\extension\icons'
New-Item -ItemType Directory -Force $dir | Out-Null
foreach ($state in 'on', 'off') {
  foreach ($s in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $r = [math]::Max(2, [int]($s * 0.22)); $d = $r * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($s - $d - 1, 0, $d, $d, 270, 90)
    $path.AddArc($s - $d - 1, $s - $d - 1, $d, $d, 0, 90); $path.AddArc(0, $s - $d - 1, $d, $d, 90, 90); $path.CloseFigure()
    $bg = if ($state -eq 'on') { [System.Drawing.Color]::FromArgb(255, 13, 13, 13) } else { [System.Drawing.Color]::FromArgb(255, 34, 34, 34) }
    $g.FillPath((New-Object System.Drawing.SolidBrush $bg), $path)
    $fg = if ($state -eq 'on') { [System.Drawing.Color]::FromArgb(255, 200, 241, 53) } else { [System.Drawing.Color]::FromArgb(255, 150, 150, 156) }
    $b = New-Object System.Drawing.SolidBrush $fg
    $u = $s / 16.0
    $rects = @(
      @(2.5, 3, 1.4, 10), @(2.5, 3, 2.6, 1.4), @(2.5, 11.6, 2.6, 1.4),        # [
      @(12.1, 3, 1.4, 10), @(10.9, 3, 2.6, 1.4), @(10.9, 11.6, 2.6, 1.4),     # ]
      @(7.1, 5, 1.5, 7.4), @(7.1, 4.4, 2.6, 1.4), @(6, 7, 3.6, 1.3)           # f
    )
    foreach ($q in $rects) { $g.FillRectangle($b, [single]($q[0] * $u), [single]($q[1] * $u), [single]($q[2] * $u), [single]($q[3] * $u)) }
    $g.Dispose()
    $bmp.Save((Join-Path $dir "$state-$s.png"), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  }
}
'ok'
