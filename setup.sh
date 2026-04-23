#!/bin/bash
# This script sets up an ACS environment

########################################################
##### SECTION 1: CONFIGURATION
########################################################

# Test image - using a public image from docker.io (no credentials needed)
# Using a recent nginx image (3-6 months old)
TEST_IMAGE="nginx:1.29"


# These variables are expected by tools from "simple-alerts.md"

# Cleanup previous configuration
unset TOKEN
unset CENTRAL
unset ROX_ADMIN_USER
unset ROX_ADMIN_PASSWORD
unset ROX_API_TOKEN
unset ROX_CENTRAL_ADDRESS



########################################################
#####      NOTE  PROBLEM WITH SANDBOX
#####  Apparantly roxctl has a conection problem with the sandbox environment
##### Using infra there are no issues
########################################################

# --- Mike Foster's Env ---
#export TOKEN=<redacted-token>
#export CENTRAL=<example-central-host>.workshops.example.com

# --- Boaz's Env demo.redhat.com ---
# vvvvvvvvvvvvvvvvvv
# Use either the API token or the admin user/password:
#export ROX_ADMIN_USER="admin"
#export ROX_ADMIN_PASSWORD="Mjc0MTA1"

#export TOKEN=<redacted-token>
#export ROX_API_TOKEN=$TOKEN

#export CENTRAL=<example-central-host>.sandbox.example.com


#boaz ACSCS
export CENTRAL=<example>.acs.rhcloud.com
export TOKEN=<redacted-token>


# Choose roxctl version: use downloaded 4.9.1 or system version
#export ROXCTL=./roxctl-4.9.1
export ROXCTL=roxctl

########################################################
##### SECTION 2: FUNCTIONS
########################################################
init() {
    export ROX_CENTRAL_ADDRESS="$CENTRAL":443
    export ROX_API_TOKEN="$TOKEN"
}


# ask - interactive prompt that waits for keypress
# Usage: ask "prompt text"
ask() {
    read -n 1 -s -p "$*"
    echo
}

# Check connection to ACS Central
check_connection() {
    echo "Trying roxctl (will timeout after 5 seconds if it fails)..."
    if "$ROXCTL" -e "$ROX_CENTRAL_ADDRESS" --insecure-skip-tls-verify --timeout='0m5s' central whoami; then
        echo "✓ roxctl connection successful"
    else
        echo ""
        echo "⚠ roxctl failed, testing with curl instead..."
        
        # Check if TOKEN is set for curl fallback
        if [ -z "$TOKEN" ]; then
            echo "✗ ERROR: TOKEN variable is not set!"
            echo ""
            echo "To fix this:"
            echo "  1. Log into your ACS instance: https://$CENTRAL"
            echo "  2. Navigate to: Platform Configuration -> Integrations -> API Token"
            echo "  3. Generate a new API token with Admin role"
            echo "  4. Edit this script and:"
            echo "     - Comment out the ROX_ADMIN_USER and ROX_ADMIN_PASSWORD lines"
            echo "     - Uncomment and set the TOKEN variable with your new API token"
            echo "     - Uncomment the 'export CENTRAL=...' line for your environment"
            echo ""
            exit 1
        fi
        
        if curl -k -s -H "Authorization: Bearer ${TOKEN}" "https://$CENTRAL/v1/metadata" | jq -r '.' ; then
            echo "✓ curl connection successful - API token is valid!"
            echo "Note: Use curl-based scripts from simple-alerts.md for this environment"
        else
            echo "✗ Both roxctl and curl failed - check your TOKEN and CENTRAL values"
            exit 1
        fi
    fi
}

########################################################
##### SECTION 3: MAIN
########################################################

# Always initialize environment variables
init

# Detect if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    # Script is being executed (bash setup.sh) - run interactive mode
    
    # Test connection
    echo -e "\nTesting connection to ACS Central..."
    check_connection

    ########################################################
    ##### IMAGE SCANNING EXAMPLES
    ########################################################

ask "Scan Image $TEST_IMAGE? (y/n)"
if [ "$REPLY" = "y" ]; then
    echo ""
    echo "=========================================="
    echo "Testing roxctl image scan..."
    echo "Image: $TEST_IMAGE"
    echo "=========================================="
    SCAN_OUTPUT=$("$ROXCTL" -e "$ROX_CENTRAL_ADDRESS" --insecure-skip-tls-verify \
        image scan --image="$TEST_IMAGE" --output=json 2>&1)

    echo ""
    echo "Summary:"
    echo "$SCAN_OUTPUT" | jq -r '.result.summary | 
        "Image: '$TEST_IMAGE'", 
        "Vulnerability Summary:", 
        "  CRITICAL: \(.CRITICAL // 0)", 
        "  IMPORTANT: \(.IMPORTANT // 0)", 
        "  MODERATE: \(.MODERATE // 0)", 
        "  LOW: \(.LOW // 0)", 
        "  Total Components: \(.["TOTAL-COMPONENTS"] // 0)", 
        "  Total Vulnerabilities: \(.["TOTAL-VULNERABILITIES"] // 0)"'

    echo "=========================================="
    ask "View Scan Raw Output? (y/n)"
    if [ "$REPLY" = "y" ]; then
        echo "$SCAN_OUTPUT" | less -S
    else
        echo "Skipping raw output view..."
    fi
else
    echo "Skipping image scan..."
fi

echo "=========================================="
ask "Run roxctl image check for $TEST_IMAGE? (y/n)"
if [ "$REPLY" = "y" ]; then
    echo ""
    echo "=========================================="
    echo "checking for violations -  roxctl image check..."
    echo "Image: $TEST_IMAGE"
    echo "=========================================="

    CHECK_OUTPUT=$("$ROXCTL" -e "$ROX_CENTRAL_ADDRESS" --insecure-skip-tls-verify image check --image="$TEST_IMAGE" 2>&1 || true)

    echo ""
    echo "Summary:"
    # Extract summary line from output (format: "TOTAL: X, LOW: Y, MEDIUM: Z, HIGH: W, CRITICAL: V")
    echo "$CHECK_OUTPUT" | grep -E "^\(TOTAL:" || echo "No policy violations found"
    
    # Count policies that break build
    BREAK_BUILD_COUNT=$(echo "$CHECK_OUTPUT" | grep -c "X" | grep -v "grep" || echo "0")
    echo "Policies that break build: $BREAK_BUILD_COUNT"
    
    echo "=========================================="
    ask "View Raw Policy Violation Output? (y/n)"
    if [ "$REPLY" = "y" ]; then
        echo "$CHECK_OUTPUT" | less -S
    else
        echo "Skipping raw output view..."
    fi
else
    echo "Skipping image check..."
fi

echo ""
echo "=========================================="
echo "Setup complete!"
echo "=========================================="

else
    # Script is being sourced (source setup.sh) - only export variables
    echo "Environment variables exported:"
    echo "  CENTRAL=$CENTRAL"
    echo "  ROX_CENTRAL_ADDRESS=$ROX_CENTRAL_ADDRESS"
    echo "  ROX_API_TOKEN=<set>"
    echo "  ROXCTL=$ROXCTL"
    echo "  TEST_IMAGE=$TEST_IMAGE"
fi
