#!/usr/bin/env python3
"""Dashboard Playwright Test — verifies all charts render with real data."""

import sys
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

DASHBOARD_URL = "http://localhost:3001/dashboard"
SCREENSHOT_PATH = "/tmp/dashboard-screenshot.png"
VIDEO_DIR = "/tmp/dashboard-video"

def main():
    Path(VIDEO_DIR).mkdir(exist_ok=True)
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/usr/bin/google-chrome-stable",
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        context = browser.new_context(
            viewport={"width": 1400, "height": 900},
            record_video_dir=VIDEO_DIR,
            record_video_size={"width": 1400, "height": 900},
        )
        page = context.new_page()
        
        # Capture errors
        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        
        print(f"Navigating to {DASHBOARD_URL}...")
        page.goto(DASHBOARD_URL, wait_until="networkidle", timeout=20000)
        
        # Wait for charts to render
        print("Waiting for charts to render...")
        time.sleep(4)
        
        # Screenshot
        page.screenshot(path=SCREENSHOT_PATH, full_page=True)
        print(f"Screenshot saved: {SCREENSHOT_PATH}")
        
        # Check error box
        error_box = page.text_content("#error-box")
        if error_box and error_box.strip():
            print(f"ERROR in dashboard: {error_box}")
        
        # Collect chart status
        chart_status = page.evaluate("""() => {
            const ids = ['chart-usage', 'chart-cost', 'chart-calls', 'chart-kalman', 'chart-system'];
            return ids.map(id => {
                const el = document.getElementById(id);
                if (!el) return {id, status: 'MISSING'};
                const svgCount = el.querySelectorAll('svg').length;
                const hasBars = el.querySelectorAll('.trace.bars').length;
                const hasScatter = el.querySelectorAll('.trace.scatter').length;
                return {
                    id,
                    status: svgCount > 0 ? 'RENDERED' : 'EMPTY',
                    svgs: svgCount,
                    hasBars: hasBars > 0,
                    hasScatter: hasScatter > 0,
                };
            });
        }""")
        
        print("\n=== Chart Status ===")
        for c in chart_status:
            emoji = "✅" if c["status"] == "RENDERED" else "❌"
            print(f"  {emoji} {c['id']}: {c['status']} (SVGs: {c.get('svgs', 0)})")
        
        # Collect stat values
        stats = page.evaluate("""() => {
            const cards = document.querySelectorAll('.stat-card');
            return Array.from(cards).map(card => {
                const label = card.querySelector('.label')?.textContent || '';
                const value = card.querySelector('.value')?.textContent || '';
                return {label, value};
            });
        }""")
        
        print("\n=== Stat Cards ===")
        for s in stats:
            print(f"  {s['label']}: {s['value']}")
        
        # Check data via API
        api_data = page.evaluate("""async () => {
            const resp = await fetch('/api/all');
            return await resp.json();
        }""")
        
        print("\n=== API Data Summary ===")
        print(f"  Keys active: {len(api_data.get('usage_by_key', []))}")
        for k in api_data.get('usage_by_key', []):
            print(f"    {k['key']}: {k['calls']} calls, {k['tokens_M']}M tokens, {k['success_rate']}% success")
        print(f"  Hourly points: {len(api_data.get('hourly', []))}")
        print(f"  Transitions: {len(api_data.get('transitions', []))}")
        print(f"  Kalman samples: {len(api_data.get('kalman', []))}")
        print(f"  Total cost 7d: ${api_data.get('costs', {}).get('total_usd_7d', 'N/A')}")
        print(f"  System CPU: {api_data.get('system', {}).get('cpu_percent', 'N/A')}%")
        print(f"  System Memory: {api_data.get('system', {}).get('memory', {}).get('used_pct', 'N/A')}%")
        print(f"  System Swap: {api_data.get('system', {}).get('swap', {}).get('used_pct', 'N/A')}%")
        
        # Scroll through page for video
        print("\nScrolling for video...")
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(1)
        page.evaluate("window.scrollTo(0, 0)")
        time.sleep(2)
        
        # Check for JS errors
        if errors:
            print(f"\n⚠️ JavaScript errors: {len(errors)}")
            for e in errors[:5]:
                print(f"  {e}")
        else:
            print("\n✅ No JavaScript errors")
        
        # Close and save video
        page.close()
        context.close()
        browser.close()
        
        # Find the video file
        video_files = list(Path(VIDEO_DIR).glob("*.webm"))
        if video_files:
            print(f"\n✅ Video saved: {video_files[0]}")
        
        all_rendered = all(c["status"] == "RENDERED" for c in chart_status)
        print(f"\n{'✅ ALL CHARTS RENDERED' if all_rendered else '❌ SOME CHARTS FAILED'}")
        
        return all_rendered and not errors

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
