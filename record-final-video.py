#!/usr/bin/env python3
"""Final dashboard video recording for Signal delivery."""

import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

DASHBOARD_URL = "http://localhost:3001/dashboard"
VIDEO_DIR = "/tmp/final-video"

def main():
    Path(VIDEO_DIR).mkdir(exist_ok=True)
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/usr/bin/google-chrome-stable",
            args=["--no-sandbox", "--disable-setuid-sandbox"],
        )
        context = browser.new_context(
            viewport={"width": 1200, "height": 800},
            record_video_dir=VIDEO_DIR,
            record_video_size={"width": 1200, "height": 800},
        )
        page = context.new_page()
        
        print("Loading dashboard...")
        page.goto(DASHBOARD_URL, wait_until="networkidle", timeout=20000)
        
        # Let it fully render
        time.sleep(3)
        
        # Scroll down slowly to show all charts
        print("Scrolling through charts...")
        for i in range(10):
            page.evaluate(f"window.scrollTo(0, {i * 300})")
            time.sleep(0.8)
        
        # Scroll back to top
        for i in range(10):
            page.evaluate(f"window.scrollTo(0, {(9-i) * 300})")
            time.sleep(0.4)
        
        # Final screenshot
        page.screenshot(path="/tmp/final-dashboard.png", full_page=True)
        
        # Verify charts
        charts = page.evaluate("""() => {
            const ids = ['chart-usage', 'chart-cost', 'chart-calls', 'chart-kalman', 'chart-system'];
            return ids.map(id => {
                const el = document.getElementById(id);
                return {id, svgs: el ? el.querySelectorAll('svg').length : 0};
            });
        }""")
        all_ok = all(c["svgs"] > 0 for c in charts)
        print(f"All charts rendered: {all_ok}")
        for c in charts:
            print(f"  {c['id']}: {c['svgs']} SVGs")
        
        # Close to finalize video
        page.close()
        context.close()
        browser.close()
        
        # Find video
        videos = list(Path(VIDEO_DIR).glob("*.webm"))
        if videos:
            print(f"Video: {videos[0]}")
        
        return all_ok

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
