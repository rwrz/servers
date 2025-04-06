#!/bin/bash
# This script runs the tests and also checks the formatters

echo "Running Vitest..."
npm test

echo -e "\n\n==============================="
echo "Testing formatters directly..."
echo "==============================="

# Create temporary directory
TEST_DIR=$(mktemp -d)
cd $TEST_DIR

echo "Creating test files..."

# Create a messy Dart file
cat > test.dart << 'EOF'
class TestWidget extends StatelessWidget {
build(BuildContext context) {
return Scaffold(
appBar: AppBar(title: Text('Test'),),
body: Container(
  child: Column(children: [
Text('Hello'),
      // A comment
ElevatedButton(
onPressed: () { },
child: Text('Click me'),
),
  ],),
),
);
}
}
EOF

# Create a messy Go file
cat > test.go << 'EOF'
package main

import "fmt"

func main(){
fmt.Println("Hello, world!")
var x=1+2
if x>2{
fmt.Println("x is greater than 2")
}
}
EOF

# Create a messy JS file
cat > test.js << 'EOF'
function hello ( ) {
console.log("Hello")
const x=1+2;
return x}
EOF

echo "Testing Dart formatter (if installed)..."
if command -v dart &> /dev/null; then
  dart format test.dart
  echo "Formatted Dart file:"
  cat test.dart
else
  echo "Dart formatter not installed."
fi

echo -e "\nTesting Go formatter (if installed)..."
if command -v gofmt &> /dev/null; then
  gofmt -w test.go
  echo "Formatted Go file:"
  cat test.go
else
  echo "Go formatter not installed."
fi

echo -e "\nTesting Prettier formatter (if installed)..."
if command -v prettier &> /dev/null || command -v npx &> /dev/null; then
  npx prettier --write test.js
  echo "Formatted JS file:"
  cat test.js
else
  echo "Prettier not installed."
fi

echo -e "\nAll tests completed!"

# Clean up
cd -
rm -rf $TEST_DIR
