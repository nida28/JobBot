# JobBot - Automated Job Application Tool

JobBot is an automated job application tool that helps you apply to multiple job postings efficiently. It uses Playwright to automate the job application process across various job boards and company websites.

## Features

- **Web-based Interface**: Simple UI for entering job URLs and managing applications
- **Multi-platform Support**: Works with various job boards (Personio, Greenhouse, Lever, etc.)
- **Automated Form Filling**: Automatically fills out application forms with your information
- **Resume Upload**: Automatically uploads your resume/CV
- **Batch Processing**: Process multiple job applications in sequence
- **Auto-submit Option**: Option to automatically submit applications or just fill forms
- **Detailed Logging**: Comprehensive logging of all application attempts
- **CSV Export**: Tracks all applications in a CSV file for record keeping

## Prerequisites

- Node.js (v14 or higher)
- npm

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Install Playwright browser:
   ```bash
   npx playwright install chromium
   ```

## Configuration

1. Place your resume/CV file in the `config/` directory
2. Create a `config/user.json` file with your personal information:
   ```json
   {
     "firstName": "Your First Name",
     "lastName": "Your Last Name",
     "email": "your.email@example.com",
     "phone": "+1234567890",
     "personalUrl": "https://your-website.com",
     "linkedin": "https://linkedin.com/in/yourprofile",
     "country": "Your Country",
     "tax": "Your Tax Status",
     "notice": "Your Notice Period",
     "salary": "Your Salary Expectation"
   }
   ```

## Usage

1. Start the server:
   ```bash
   npm start
   ```

2. Open your browser and go to `http://localhost:3000`

3. In the web interface:
   - Paste job URLs (one per line) in the text area
   - Choose whether to auto-submit applications
   - Click "Start" to begin processing

4. A browser window will open and automatically process each job application

## Project Structure

```
JobBot/
├── client/                 # Frontend web interface
│   ├── index.html         # Main web page
│   ├── app.js            # Frontend JavaScript
│   └── styles.css        # Styling
├── server/               # Backend server
│   ├── server.mjs       # Express server
│   └── runner.mjs       # Job application automation logic
├── config/              # Configuration files
│   ├── user.json        # Your personal information
│   └── NidaaMunglooResume.pdf  # Your resume
├── logs/                # Application logs
├── output/              # Generated files (CSV exports)
└── package.json         # Project dependencies
```

## Scripts

- `npm start` - Start the production server
- `npm run dev` - Start the development server (uses runner.mjs)

## How It Works

1. **URL Processing**: The system accepts job URLs from various job boards
2. **Form Detection**: Automatically detects and maps form fields using intelligent selectors
3. **Data Filling**: Fills out forms with your personal information from `config/user.json`
4. **Resume Upload**: Automatically uploads your resume file
5. **Submission**: Optionally submits the application or just fills the form
6. **Logging**: Records all attempts and results in logs and CSV files

## Supported Job Boards

The tool works with various job application systems including:
- Personio
- Greenhouse
- Lever
- And many other standard job application forms

## Logs and Output

- **Console Logs**: Real-time logging in the terminal
- **Log Files**: Detailed logs saved in the `logs/` directory
- **CSV Export**: Application tracking in `output/applied.csv`


## Security Notes

- Keep your personal information in `config/user.json` secure
- Don't commit sensitive information to version control
- The tool runs locally on your machine for privacy

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Please respect the terms of service of job boards and use responsibly.
