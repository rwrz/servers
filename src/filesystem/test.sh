#!/bin/bash
# Script to test if formatters are working correctly inside the Docker container

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

echo "Testing Dart formatter..."
dart format test.dart
echo "Formatted Dart file:"
cat test.dart

echo -e "\nTesting Go formatter..."
gofmt -w test.go
echo "Formatted Go file:"
cat test.go

echo -e "\nTesting Prettier formatter..."
prettier --write test.js
echo "Formatted JS file:"
cat test.js

echo -e "\nAll tests completed!"